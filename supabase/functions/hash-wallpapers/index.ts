import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const MAX_ITEMS = 150;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const ALLOWED_IMAGE_HOST = "i.ibb.co";

function approvedUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname !== ALLOWED_IMAGE_HOST ||
        parsed.port || parsed.username || parsed.password) return null;
    return parsed;
  } catch { return null; }
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await run(controller.signal); }
  finally { clearTimeout(timer); }
}

// A reliable Content-Length lets us rule out different-sized files without
// downloading their image bodies. Missing/encoded lengths fall back to hashing.
async function inspectSize(item: { id: string; url: string }): Promise<{ id: string; error?: string; needsHash?: boolean; bytes?: number }> {
  const parsed = approvedUrl(item.url);
  if (!parsed) return { id: item.id, error: "Image URL is not on the approved ImgBB image host." };
  try {
    const head = await withTimeout(10000, signal => fetch(parsed.toString(), {
      method: "HEAD", redirect: "manual", signal, headers: { "Accept": "image/*" },
    }));
    if (!head.ok || head.status >= 300) return { id: item.id, needsHash: true };
    const type = head.headers.get("content-type") || "";
    const lengthHeader = head.headers.get("content-length");
    const encoding = head.headers.get("content-encoding");
    if (!type.toLowerCase().startsWith("image/")) {
      return { id: item.id, error: "The hosted URL did not return an image." };
    }
    if (lengthHeader && !encoding) {
      const bytes = Number(lengthHeader);
      if (!Number.isFinite(bytes) || bytes <= 0) return { id: item.id, needsHash: true };
      if (bytes > MAX_IMAGE_BYTES) return { id: item.id, error: "Image exceeds the 40 MB scan limit." };
      return { id: item.id, bytes, needsHash: false };
    }
    return { id: item.id, needsHash: true };
  } catch {
    return { id: item.id, needsHash: true };
  }
}

async function hashOne(item: { id: string; url: string }) {
  const parsed = approvedUrl(item.url);
  if (!parsed) return { id: item.id, error: "Image URL is not on the approved ImgBB image host." };
  try {
    return await withTimeout(20000, async signal => {
      const response = await fetch(parsed.toString(), {
        method: "GET", redirect: "manual", signal, headers: { "Accept": "image/*" },
      });
      if (!response.ok || response.status >= 300) {
        return { id: item.id, error: "ImgBB image could not be fetched directly from the approved host." };
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().startsWith("image/")) {
        return { id: item.id, error: "The hosted URL did not return an image." };
      }
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > MAX_IMAGE_BYTES) {
        return { id: item.id, error: "Image exceeds the 40 MB scan limit." };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
        return { id: item.id, error: "Image is empty or exceeds the 40 MB scan limit." };
      }
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
      return { id: item.id, hash, bytes: bytes.length };
    });
  } catch (error) {
    return {
      id: item.id,
      error: error instanceof Error && error.name === "AbortError"
        ? "Image request timed out."
        : "Image could not be verified.",
    };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await fn(items[index]);
    }
  }));
  return output;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { success: false, error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    return reply(500, { success: false, error: "Image verification service is not configured." });
  }

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    return reply(401, { success: false, error: "Sign in as an administrator first." });
  }

  try {
    const authResponse = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: authorization },
    });
    if (!authResponse.ok) return reply(401, { success: false, error: "Your session is invalid or expired. Sign in again." });
    const user = await authResponse.json();
    if (user?.app_metadata?.role !== "admin") {
      return reply(403, { success: false, error: "Only an authorized administrator can scan the gallery." });
    }

    const payload = await req.json();
    const items = payload?.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) {
      return reply(400, { success: false, error: "Send between 1 and 150 wallpaper URLs per scan request." });
    }
    const validItems = items.filter((item: unknown) =>
      item && typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { url?: unknown }).url === "string" &&
      (item as { id: string }).id.length <= 128 &&
      (item as { url: string }).url.length <= 2048
    );
    if (validItems.length !== items.length) {
      return reply(400, { success: false, error: "One or more scan items are invalid." });
    }

    // Forced mode is used only for files whose sizes matched across separate
    // browser batches. Hash every supplied item so cross-batch duplicates are found.
    if (payload?.forceHash === true) {
      const hashes = await mapLimit(validItems, 6, hashOne);
      return reply(200, {
        success: true,
        results: hashes,
        stats: { checked: validItems.length, hashed: validItems.length, skippedByUniqueSize: 0 },
      });
    }

    // First pass: small HEAD requests in parallel.
    const inspections = await mapLimit(validItems, 16, inspectSize);
    const results = new Map<string, Record<string, unknown>>();
    const sizeGroups = new Map<number, typeof validItems>();
    inspections.forEach((inspection, index) => {
      if (inspection.error) {
        results.set(inspection.id, inspection);
      } else if (inspection.needsHash) {
        const id = validItems[index].id;
        // Unknown sizes must be hashed; use a dedicated bucket per item so
        // we never assume unknown lengths are equal.
        sizeGroups.set(-index - 1, [validItems[index]]);
      } else {
        const bytes = inspection.bytes as number;
        if (!sizeGroups.has(bytes)) sizeGroups.set(bytes, []);
        sizeGroups.get(bytes)!.push(validItems[index]);
      }
    });

    const hashCandidates: typeof validItems = [];
    for (const [size, group] of sizeGroups) {
      if (size > 0 && group.length === 1) {
        results.set(group[0].id, { id: group[0].id, uniqueBySize: true, bytes: size });
      } else {
        hashCandidates.push(...group);
      }
    }

    // Second pass: only equal-sized candidates (plus unknown-size fallbacks)
    // download full bodies. This is the expensive step, so keep it bounded.
    const hashes = await mapLimit(hashCandidates, 6, hashOne);
    hashes.forEach(item => results.set(item.id as string, item));
    return reply(200, {
      success: true,
      results: validItems.map(item => results.get(item.id) || { id: item.id, error: "Image could not be verified." }),
      stats: { checked: validItems.length, hashed: hashCandidates.length, skippedByUniqueSize: validItems.length - hashCandidates.length },
    });
  } catch (error) {
    console.error("REALGX exact duplicate scan failed:", error);
    return reply(500, { success: false, error: "The duplicate scan encountered an unexpected error." });
  }
});
