/**
 * OpenRouter client helpers.
 *
 * - STT:           /api/v1/audio/transcriptions  (dedicated endpoint)
 * - Summarization: /api/v1/chat/completions       (chat endpoint)
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/** Call OpenRouter chat completions */
async function chatCompletion(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: unknown }>,
  options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
): Promise<string> {
  const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://pi.dev",
      "X-OpenRouter-Title": "pi-voice",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: options && options.maxTokens ? options.maxTokens : 1024,
      temperature: options && options.temperature ? options.temperature : 0.3,
    }),
    signal: options ? options.signal : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenRouter error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error && data.error.message) {
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  const content = data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content ? data.choices[0].message.content : "";  return content.trim();
}

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

/**
 * Summarize text (TL;DR) via OpenRouter.
 */
export async function summarizeText(
  apiKey: string,
  text: string,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  const messages = [
    {
      role: "user",
      content: `Provide a very brief TL;DR summary (2-3 sentences max) of the following. Focus on what was accomplished or decided. Be concise and direct.\n\n${text}`,
    },
  ];

  const result = await chatCompletion(apiKey, model, messages, {
    maxTokens: 256,
    temperature: 0.3,
    signal,
  });

  return result;
}

/**
 * Convert text to speech …?  OpenRouter doesn't have a TTS endpoint natively.
 * We use espeak-ng locally. If not available, we return null.
 * In the future, could use OpenAI-compatible TTS via OpenRouter if they add it.
 */
export async function textToSpeechAvailable(): Promise<boolean> {
  const { hasCmd } = await import("./audio.js");
  return hasCmd("espeak-ng") || hasCmd("espeak");
}
