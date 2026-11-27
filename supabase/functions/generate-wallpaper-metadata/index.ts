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
const allowedModels = [
  "openai/gpt-4.1-mini",
  "anthropic/claude-sonnet-4.5",
  "google/gemini-2.5-flash",
];

const promptFor = (fileName: string) => `You are the senior image curator for REALGX 4K, a high-quality wallpaper gallery.
Inspect the ACTUAL image, not just its filename. Return accurate metadata in JSON with exactly these fields:
1. title: a distinctive, natural title of 3–8 words that describes the main visible subject. Never use generic titles such as "Untitled", "Wallpaper", "Image", or "Photo".
2. description: 2 concise, polished sentences describing only what is visibly present: main subject, setting, composition, colours, lighting and visual style. Avoid awkward filler, repetition, keyword stuffing, guesses, or claims not supported by the image.
3. category: choose exactly one category from the list below, based on the main subject and visual content:
- Cars: cars, automobiles, motorcycles or other vehicles are the main subject. A car image MUST be Cars, even if its style is minimal, dark, cinematic or neon.
- Nature: landscapes, mountains, forests, oceans, plants, flowers, skies or wildlife.
- Anime: anime/manga characters or clearly anime-styled artwork.
- Gaming: video game characters, scenes, environments or gaming artwork.
- Cyberpunk: futuristic neon cityscapes, sci-fi technology or cyberpunk scenes when those are the main subject and it is not primarily a car.
- Minimalist: deliberately sparse abstract, geometric or typographic designs with no stronger subject category. Do NOT use this as a generic fallback.
Filename for reference only: ${fileName.slice(0, 180)}
If the image is ambiguous, describe only what is certain and choose the closest category. Never infer category from filename alone.`;

function validateMetadata(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("AI response was not a JSON object.");
  const data = value as Record<string, unknown>;
  const title = typeof data.title === "string" ? data.title.trim().replace(/^["']|["']$/g, "") : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  const category = typeof data.category === "string" ? data.category.trim() : "";
  if (!title || title.length < 4 || /^(untitled|wallpaper|image|photo)(\s*\d*)?$/i.test(title)) {
    throw new Error("AI returned a generic or missing title.");
  }
  if (description.length < 35) throw new Error("AI returned a description that is too short.");
  if (!categories.includes(category as typeof categories[number])) throw new Error("AI returned an unsupported category.");
  return { title: title.slice(0, 120), description: description.slice(0, 1000), category };
}

async function callGemini(apiKey: string, model: string, prompt: string, contentType: string, imageBase64: string) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, "Api-Revision": "2026-05-20" },
    signal: AbortSignal.timeout(18_000),
    body: JSON.stringify({
      model, store: false,
      input: [
        { type: "text", text: prompt },
        { type: "image", mime_type: contentType, data: imageBase64 },
      ],
      response_format: {
        type: "text", mime_type: "application/json",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            category: { type: "string", enum: [...categories] },
          },
          required: ["title", "description", "category"],
        },
      },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${result?.error?.message || "request failed"}`);
  const outputParts = (result?.steps || [])
    .filter((step: { type?: string }) => step.type === "model_output")
    .flatMap((step: { content?: Array<{ type?: string; text?: string }> }) => step.content || []);
  const text = (result?.output_text || outputParts
    .filter((part: { type?: string }) => part.type === "text")
    .map((part: { text?: string }) => part.text || "")
    .join("")).trim();
  if (!text) throw new Error("Gemini returned no metadata.");
  return validateMetadata(JSON.parse(text));
}

async function callOpenRouter(apiKey: string, model: string, prompt: string, contentType: string, imageBase64: string) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://realgx.vercel.app",
      "X-Title": "REALGX 4K Wallpaper Metadata",
    },
    signal: AbortSignal.timeout(22_000),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 450,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a precise visual metadata editor. Follow the user's category rules exactly. Return only valid JSON." },
        {
          role: "user",
          content: [
            { type: "text", text: prompt + "\nReturn a JSON object with title, description, and category." },
            { type: "image_url", image_url: { url: `data:${contentType};base64,${imageBase64}`, detail: "low" } },
          ],
        },
      ],
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}: ${result?.error?.message || "request failed"}`);
  const content = result?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.map((part: { text?: string }) => part?.text || "").join("") : "";
  if (!text.trim()) throw new Error("OpenRouter returned no metadata.");
  const cleaned = text.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  return validateMetadata(JSON.parse(cleaned));
}


async function callGroq(apiKey: string, model: string, prompt: string, contentType: string, imageBase64: string) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(22_000),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_completion_tokens: 550,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a precise visual metadata editor. Inspect the image itself, follow the category rules exactly, and return only valid JSON." },
        {
          role: "user",
          content: [
            { type: "text", text: prompt + "\nReturn a JSON object with title, description, and category." },
            { type: "image_url", image_url: { url: `data:${contentType};base64,${imageBase64}` } },
          ],
        },
      ],
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Groq HTTP ${response.status}: ${result?.error?.message || "request failed"}`);
  const content = result?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.map((part: { text?: string }) => part?.text || "").join("") : "";
  if (!text.trim()) throw new Error("Groq returned no metadata.");
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return validateMetadata(JSON.parse(cleaned));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply(405, { success: false, error: "Method not allowed." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) return reply(500, { success: false, error: "Supabase function environment is not configured." });

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return reply(401, { success: false, error: "Sign in as an administrator first." });

  try {
    const authResponse = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: authorization },
    });
    if (!authResponse.ok) return reply(401, { success: false, error: "Your session is invalid or expired. Sign in again." });
    const user = await authResponse.json();
    if (user?.app_metadata?.role !== "admin") return reply(403, { success: false, error: "This account is not authorized to generate wallpaper metadata." });

    const payload = await req.json();
    const { fileName, contentType, imageBase64 } = payload ?? {};
    if (typeof fileName !== "string" || typeof imageBase64 !== "string" || !imageBase64) return reply(400, { success: false, error: "Missing image data or filename." });
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (typeof contentType !== "string" || !allowedTypes.includes(contentType.toLowerCase())) return reply(400, { success: false, error: "AI metadata supports JPEG, PNG, WEBP and GIF images." });
    if (imageBase64.length > 4_200_000) return reply(413, { success: false, error: "Image is too large for AI analysis. Use an image no larger than 3 MB." });

    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    const openRouterKey = Deno.env.get("OPENROUTER_API_KEY");
    const groqKey = Deno.env.get("GROQ_API_KEY");
    const groqModel = (Deno.env.get("GROQ_MODEL") || "qwen/qwen3.8-27b").trim();
    const geminiModel = (Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash").trim();
    const requestedModel = typeof payload.openRouterModel === "string" ? payload.openRouterModel.trim() : "";
    const openRouterModel = allowedModels.includes(requestedModel) ? requestedModel :
      (Deno.env.get("OPENROUTER_MODEL") || "openai/gpt-4.1-mini").trim();
    const prompt = promptFor(fileName);
    const failures: string[] = [];

    if (geminiKey) {
      try {
        const metadata = await callGemini(geminiKey, geminiModel, prompt, contentType.toLowerCase(), imageBase64);
        return reply(200, { success: true, provider: "gemini", model: geminiModel, metadata });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gemini failed";
        console.warn("REALGX Gemini metadata provider failed; trying OpenRouter:", message);
        failures.push(message);
      }
    } else {
      failures.push("Gemini API key is not configured.");
    }

    if (openRouterKey) {
      try {
        const metadata = await callOpenRouter(openRouterKey, openRouterModel, prompt, contentType.toLowerCase(), imageBase64);
        return reply(200, { success: true, provider: "openrouter", model: openRouterModel, metadata, fallback: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "OpenRouter failed";
        console.error("REALGX OpenRouter metadata provider failed:", message);
        failures.push(message);
      }
    } else {
      failures.push("OpenRouter API key is not configured.");
    }

    if (groqKey) {
      try {
        const metadata = await callGroq(groqKey, groqModel, prompt, contentType.toLowerCase(), imageBase64);
        return reply(200, { success: true, provider: "groq", model: groqModel, metadata, fallback: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Groq failed";
        console.error("REALGX Groq metadata provider failed:", message);
        failures.push(message);
      }
    } else {
      failures.push("Groq API key is not configured (GROQ_API_KEY).");
    }

    return reply(502, {
      success: false,
      error: "Gemini, OpenRouter and Groq all failed. No placeholder metadata was generated. " + failures.join(" | ").slice(0, 700),
    });
  } catch (error) {
    console.error("REALGX metadata service error:", error);
    return reply(500, {
      success: false,
      error: error instanceof Error && error.name === "TimeoutError"
        ? "The AI provider took too long to respond. Please retry."
        : "The AI metadata service encountered an unexpected error.",
    });
  }
});
