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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { success: false, error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const imgbbApiKey = Deno.env.get("IMGBB_API_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !imgbbApiKey) {
    return reply(500, { success: false, error: "Upload service is not configured. Add IMGBB_API_KEY to Supabase Edge Function secrets." });
  }

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    return reply(401, { success: false, error: "Sign in as an administrator first." });
  }

  try {
    // Verify the bearer token with Supabase Auth; do not trust client-supplied role fields.
    const authResponse = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: authorization },
    });
    if (!authResponse.ok) return reply(401, { success: false, error: "Your session is invalid or expired. Sign in again." });
    const user = await authResponse.json();
    if (user?.app_metadata?.role !== "admin") {
      return reply(403, { success: false, error: "This account is not authorized to upload wallpapers." });
    }

    const payload = await req.formData();
    const imageFile = payload.get("file");
    const requestedName = payload.get("fileName");
    if (!(imageFile instanceof File) || typeof requestedName !== "string" || !requestedName.trim()) {
      return reply(400, { success: false, error: "Missing image file or filename." });
    }
    if (!imageFile.type || !imageFile.type.startsWith("image/")) {
      return reply(400, { success: false, error: "Only image files are accepted." });
    }

    const maxImageBytes = 25 * 1024 * 1024;
    if (imageFile.size === 0 || imageFile.size > maxImageBytes) {
      return reply(413, { success: false, error: "Image must be 25 MB or smaller." });
    }

    const safeName = requestedName.replace(/[\\/\0]/g, "_").slice(0, 180) || "wallpaper";
    const form = new FormData();
    // Reuse the parsed File directly; no base64 conversion or extra byte copy.
    form.append("image", imageFile, safeName);
    form.append("name", safeName.replace(/\.[^.]+$/, "").slice(0, 180));

    const uploadResponse = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(imgbbApiKey)}`, {
      method: "POST",
      body: form,
    });
    const result = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok || !result.success || !result.data?.url) {
      return reply(502, { success: false, error: result.error?.message || "ImgBB could not complete the upload." });
    }

    return reply(200, {
      success: true,
      preview_url: result.data.medium?.url || result.data.display_url || result.data.url,
      full_url: result.data.url,
    });
  } catch (error) {
    console.error("REALGX ImgBB upload failed:", error);
    return reply(500, { success: false, error: "The upload service encountered an unexpected error." });
  }
});