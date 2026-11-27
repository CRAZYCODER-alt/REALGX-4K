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

const MAX_ITEMS = 10;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const ALLOWED_IMAGE_HOST = "i.ibb.co";

async function hashOne(item: { id: string; url: string }) {
  const parsed = new URL(item.url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== ALLOWED_IMAGE_HOST ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    return { id: item.id, error: "Image URL is not on the approved ImgBB image host." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "Accept": "image/*" },
    });
    const finalUrl = new URL(response.url);
    if (!response.ok || finalUrl.protocol !== "https:" || finalUrl.hostname !== ALLOWED_IMAGE_HOST) {
      return { id: item.id, error: "ImgBB image could not be fetched from the approved host." };
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
  } catch (error) {
    return {
      id: item.id,
      error: error instanceof Error && error.name === "AbortError"
        ? "Image request timed out."
        : "Image could not be verified.",
    };
  } finally {
    clearTimeout(timeout);
  }
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
      return reply(400, { success: false, error: "Send between 1 and 10 wallpaper URLs per scan request." });
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

    const results = await Promise.all(validItems.map((item: { id: string; url: string }) => hashOne(item)));
    return reply(200, { success: true, results });
  } catch (error) {
    console.error("REALGX exact duplicate scan failed:", error);
    return reply(500, { success: false, error: "The duplicate scan encountered an unexpected error." });
  }
});
