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

const categories = ["Gaming", "Nature", "Anime", "Cyberpunk", "Minimalist", "Cars"] as const;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { success: false, error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    return reply(500, { success: false, error: "Supabase function environment is not configured." });
  }
  if (!geminiApiKey) {
    return reply(503, {
      success: false,
      error: "Gemini is not configured yet. Add GEMINI_API_KEY to Supabase Edge Function secrets, then retry.",
    });
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
      return reply(403, { success: false, error: "This account is not authorized to generate wallpaper metadata." });
    }

    const payload = await req.json();
    const { fileName, contentType, imageBase64 } = payload ?? {};
    if (typeof fileName !== "string" || typeof imageBase64 !== "string" || !imageBase64) {
      return reply(400, { success: false, error: "Missing image data or filename." });
    }
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (typeof contentType !== "string" || !allowedTypes.includes(contentType.toLowerCase())) {
      return reply(400, { success: false, error: "AI metadata supports JPEG, PNG, WEBP and GIF images." });
    }
    if (imageBase64.length > 4_200_000) {
      return reply(413, { success: false, error: "Image is too large for AI analysis. Use an image no larger than 3 MB." });
    }

    const model = (Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash").trim();
    const prompt = `You are the metadata editor for REALGX 4K, a wallpaper gallery.
Examine the supplied wallpaper image itself. Generate:
- title: a distinctive, concise, natural title (about 3–8 words); do not mention resolution unless visible or supplied.
- description: an accurate, appealing 1–2 sentence description of visible subjects, setting, colours, composition and artistic style. Do not invent objects, locations, artists, brands, stories or technical details that cannot be seen.
- category: choose exactly one of Gaming, Nature, Anime, Cyberpunk, Minimalist, Cars. Choose the closest category; use Minimalist when none fits well.
The original filename is: ${fileName.slice(0, 180)}.
Return only data matching the requested JSON schema.`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { text: prompt },
            { inlineData: { mimeType: contentType.toLowerCase(), data: imageBase64 } },
          ] }],
          generationConfig: {
            temperature: 0.35,
            maxOutputTokens: 300,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                title: { type: "STRING" },
                description: { type: "STRING" },
                category: { type: "STRING", enum: [...categories] },
              },
              required: ["title", "description", "category"],
            },
          },
        }),
      },
    );
    const result = await geminiResponse.json().catch(() => ({}));
    if (!geminiResponse.ok) {
      console.error("Gemini API error:", result?.error?.message || geminiResponse.status);
      const status = geminiResponse.status === 429 ? 429 : 502;
      return reply(status, {
        success: false,
        error: geminiResponse.status === 429
          ? "Gemini rate limit or quota reached. Wait a little and retry."
          : "Gemini could not analyse this image. Check the API key, model availability and quota.",
      });
    }

    const text = result?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
    if (!text) return reply(502, { success: false, error: "Gemini returned no metadata for this image." });
    let metadata: { title?: unknown; description?: unknown; category?: unknown };
    try { metadata = JSON.parse(text); }
    catch { return reply(502, { success: false, error: "Gemini returned invalid metadata. Please retry." }); }

    const title = typeof metadata.title === "string" ? metadata.title.trim().slice(0, 120) : "";
    const description = typeof metadata.description === "string" ? metadata.description.trim().slice(0, 1000) : "";
    const category = categories.includes(metadata.category as typeof categories[number])
      ? metadata.category as typeof categories[number]
      : "Minimalist";
    if (!title || !description) return reply(502, { success: false, error: "Gemini returned incomplete metadata. Please retry." });

    return reply(200, { success: true, metadata: { title, description, category }, model });
  } catch (error) {
    console.error("REALGX Gemini metadata error:", error);
    return reply(500, {
      success: false,
      error: error instanceof Error && error.name === "TimeoutError"
        ? "Gemini took too long to respond. Please retry."
        : "The AI metadata service encountered an unexpected error.",
    });
  }
});
