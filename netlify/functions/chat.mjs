import { GoogleGenAI } from "@google/genai";

function createGeminiClient(useGateway) {
  if (!useGateway || process.env.GOOGLE_GEMINI_BASE_URL?.trim()) {
    return new GoogleGenAI({});
  }

  const gatewayKey = process.env.NETLIFY_AI_GATEWAY_KEY?.trim();
  const gatewayUrl = process.env.NETLIFY_AI_GATEWAY_URL?.trim();
  if (!gatewayKey || !gatewayUrl) {
    throw new Error("AI Gateway runtime configuration is unavailable");
  }
  const defaults = {
    GEMINI_API_KEY: gatewayKey,
    GOOGLE_API_KEY: undefined,
    GOOGLE_GEMINI_BASE_URL: gatewayUrl.replace(/\/$/, ""),
  };
  const previous = Object.fromEntries(Object.keys(defaults).map((name) => [name, process.env[name]]));

  function applyDefaults(values) {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  try {
    applyDefaults(defaults);
    return new GoogleGenAI({});
  } finally {
    applyDefaults(previous);
  }
}

export default async function chat(request, context) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const body = await request.json().catch(() => null);
  if (typeof body?.message !== "string" || !body.message.trim()) {
    return Response.json({ error: "invalid_message" }, { status: 400 });
  }

  const useGateway = context?.deploy?.context === "deploy-preview";
  const requestId = context?.requestId;
  try {
    const ai = createGeminiClient(useGateway);
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: body.message.trim(),
    });

    const reply = response.text;
    if (!reply?.trim()) {
      console.warn("[chat] Gemini returned no text", { requestId });
      return Response.json({ error: "empty_reply", requestId }, { status: 502 });
    }
    return Response.json({ reply });
  } catch (error) {
    const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY?.trim());
    const hasGoogleKey = Boolean(process.env.GOOGLE_API_KEY?.trim());
    const hasGatewayBaseUrl = Boolean(process.env.GOOGLE_GEMINI_BASE_URL?.trim());
    const hasGatewayDefaults = Boolean(process.env.NETLIFY_AI_GATEWAY_KEY?.trim() &&
      process.env.NETLIFY_AI_GATEWAY_URL?.trim());
    const hasCredentials = useGateway && !hasGatewayBaseUrl ? hasGatewayDefaults : hasGeminiKey || hasGoogleKey;
    const upstreamStatus = Number.isInteger(error?.status) ? error.status : undefined;
    let code = "gemini_unavailable";
    let status = 502;

    if (upstreamStatus === 429) {
      code = "rate_limited";
      status = 429;
    } else if (!hasCredentials || upstreamStatus === 401 || upstreamStatus === 403 ||
      /API_KEY_(INVALID|EXPIRED)|API key (not valid|expired)/i.test(error?.message ?? "")) {
      code = "gemini_configuration";
      status = 503;
    }

    console.error("[chat] Gemini request failed", {
      requestId, code, upstreamStatus, useGateway, hasGeminiKey, hasGoogleKey, hasGatewayBaseUrl, hasGatewayDefaults,
    });
    return Response.json({ error: code, requestId }, { status });
  }
}
