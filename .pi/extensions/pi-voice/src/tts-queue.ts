/**
 * Fire-and-forget TTS background queue + shared speakText pipeline.
 *
 * Extracts the common TTS logic (humanize → summarize/truncate → piper/espeak → play)
 * so both the auto-TTS hook and the /speak command share one code path.
 *
 * The background queue serialises TTS playback so audio never overlaps,
 * and catches all errors so a background failure never crashes the agent.
 */

import { humanizeForSpeech } from "./humanize.js";
import type { AudioBackends } from "./types.js";
import type { PiperStatus } from "./local.js";
import { speakWithPiper, truncateForSpeech } from "./local.js";
import { playWav, speakViaEspeak } from "./audio.js";
import { unlinkSync } from "node:fs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SpeakOptions {
  /** Available audio backends (player detection) */
  audio: AudioBackends;
  /** Piper status (neural TTS) */
  piper: PiperStatus;
  /** Whether to use TL;DR summarisation */
  tldrMode: boolean;
  /** Already-summarised text (if summarisation was done upstream) */
  summarizedText?: string;
  /** Optional summarizer — called with text, returns summary string */
  summarize?: (text: string) => Promise<string>;
  /** Override the speed for espeak (default 175) */
  espeakSpeed?: number;
  /** Override max chars for truncation fallback (default 300) */
  truncateMaxChars?: number;
}

// ─── Background TTS Queue ───────────────────────────────────────────────────

type Task = () => Promise<void>;

let queue: Task[] = [];
let running = false;
let taskId = 0;

async function processQueue(): Promise<void> {
  if (running) return;
  running = true;

  while (queue.length > 0) {
    const task = queue.shift()!;
    try {
      await task();
    } catch (err: any) {
      console.error("[pi-voice] Background TTS error:", err.message);
    }
  }

  running = false;
}

/**
 * Enqueue a fire-and-forget TTS task.
 * Returns immediately — the task runs in the background and errors are logged
 * but never propagate.
 */
export function enqueueTts(task: Task): void {
  queue.push(task);
  processQueue();
}

/**
 * Clear any pending (not yet started) TTS tasks.
 * Useful when the user starts a new /voice recording mid-playback.
 */
export function clearPendingTts(): void {
  queue = [];
}

// ─── Core Speech Pipeline ───────────────────────────────────────────────────

/**
 * Speak the given text using the best available TTS backend.
 *
 * 1. Humanize the text (strip markdown, emoji, URLs, etc.)
 * 2. Truncate if too long (or use pre-summarized text)
 * 3. Play via piper (neural) → espeak-ng (fallback)
 *
 * Returns the humanized speech text that was (or will be) spoken.
 */
export async function speakText(
  text: string,
  options: SpeakOptions,
): Promise<string> {
  let textToSpeak = text;

  // Step 1: Summarize or truncate
  if (options.summarizedText) {
    textToSpeak = options.summarizedText;
  } else if (options.tldrMode && options.summarize) {
    try {
      const summary = await options.summarize(text);
      if (summary && summary.trim()) {
        textToSpeak = summary.trim();
      }
    } catch {
      // Fall through to truncation
    }
  }

  // Truncation fallback (if text is still long)
  if (textToSpeak.length > (options.truncateMaxChars ?? 300)) {
    textToSpeak = truncateForSpeech(textToSpeak, options.truncateMaxChars ?? 300);
  }

  // Step 2: Humanize for speech
  const speechText = humanizeForSpeech(textToSpeak);
  if (!speechText.trim()) return "";

  // Step 3: Play audio
  if (!options.audio.canPlay || !options.audio.player) {
    console.warn("[pi-voice] No audio player available for TTS.");
    return speechText;
  }

  if (options.piper.available) {
    try {
      const wavPath = await speakWithPiper(speechText, options.piper);
      await playWav(wavPath, options.audio.player);
      try {
        unlinkSync(wavPath);
      } catch { /* ignore cleanup failures */ }
    } catch (piperErr: any) {
      console.warn("[pi-voice] Piper failed, falling back to espeak:", piperErr.message);
      if (options.audio.hasEspeak) {
        await speakViaEspeak(speechText, options.audio.player, options.espeakSpeed ?? 175);
      }
    }
  } else if (options.audio.hasEspeak) {
    await speakViaEspeak(speechText, options.audio.player, options.espeakSpeed ?? 175);
  }

  return speechText;
}

// ─── Queue Info ─────────────────────────────────────────────────────────────

export function getQueueLength(): number {
  return queue.length;
}

export function isQueueRunning(): boolean {
  return running;
}
