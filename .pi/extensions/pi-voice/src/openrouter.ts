/**
 * OpenRouter client helpers.
 *
 * - STT: /api/v1/audio/transcriptions (dedicated endpoint)
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/**
 * Transcribe audio via OpenRouter's dedicated STT endpoint.
 */
export async function transcribeAudio(
  apiKey: string,
  base64Audio: string,
  model: string,
  format: string,
  language: string,
  signal?: AbortSignal,
): Promise<string> {
  const resp = await fetch(`${OPENROUTER_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://pi.dev",
      "X-OpenRouter-Title": "pi-voice",
    },
    body: JSON.stringify({
      model,
      input_audio: {
        data: base64Audio,
        format,
      },
      ...(language && language !== "auto" ? { language } : {}),
    }),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenRouter error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as {
    text?: string;
    error?: { message?: string };
    usage?: Record<string, unknown>;
  };

  if (data.error && data.error.message) {
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  return (data.text || "").trim();
}



