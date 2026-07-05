/**
 * Local STT backend — no network required.
 *
 * STT: whisper.cpp (whisper-cli)
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cpus } from "node:os";
import { hasCmd } from "./audio.js";

// ─── Performance config ─────────────────────────────────────────────────────

/** Use all available CPU cores (whisper default is 4). Contains to 1-16. */
const OPTIMAL_THREADS = Math.max(1, Math.min(cpus() && cpus().length ? cpus().length : 4, 16));

// ─── Whisper (local STT) ────────────────────────────────────────────────────

const WHISPER_MODEL_DIRS = [
  join(homedir(), ".local", "share", "whisper"),
  join(homedir(), "whisper-models"),
  "/usr/share/whisper",
  "/usr/local/share/whisper",
];

const WHISPER_MODEL_PATTERNS = [
  "ggml-base.en.bin",
  "ggml-base.bin",
  "ggml-small.en.bin",
  "ggml-small.bin",
  "ggml-tiny.en.bin",
  "ggml-tiny.bin",
  "ggml-medium.en.bin",
  "ggml-medium.bin",
];

export interface WhisperStatus {
  available: boolean;
  cli: string | null;
  modelPath: string | null;
  modelName: string | null;
}

export function detectWhisper(): WhisperStatus {
  const cli = hasCmd("whisper-cli") ? "whisper-cli" : hasCmd("main") ? "main" : null;
  if (!cli) return { available: false, cli: null, modelPath: null, modelName: null };

  for (const dir of WHISPER_MODEL_DIRS) {
    for (const pattern of WHISPER_MODEL_PATTERNS) {
      const path = join(dir, pattern);
      if (existsSync(path)) {
        return { available: true, cli, modelPath: path, modelName: pattern };
      }
    }
  }
  return { available: false, cli, modelPath: null, modelName: null };
}

export function transcribeWithWhisper(
  wavPath: string,
  status: WhisperStatus,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!status.available || !status.cli || !status.modelPath) {
      reject(new Error("whisper.cpp not configured. Run setup-voice-models or /voice-diagnose."));
      return;
    }

    const outPrefix = join(tmpdir(), `whisper-out-${Date.now()}`);
    const txtPath = outPrefix + ".txt";

    execFile(
      status.cli,
      [
        "-m", status.modelPath,
        "-f", wavPath,
        "-otxt",
        "-of", outPrefix,
        "-np",
        "--language", "en",
        "--no-timestamps",
        // ---- Performance tuning ----
        "--threads", String(OPTIMAL_THREADS),
        "--beam-size", "1",
        "--best-of", "1",
      ],
      { encoding: "utf8", signal, timeout: 120000 } as any,
      (err: Error | null) => {
        // whisper-cli may exit non-zero but still write output
        if (existsSync(txtPath)) {
          try {
            const text = readFileSync(txtPath, "utf8").trim();
            try { unlinkSync(txtPath); } catch { /* */ }
            if (text) {
              resolve(text);
              return;
            }
          } catch { /* file not readable */ }
        }

        try { unlinkSync(txtPath); } catch { /* */ }

        if (err) {
          reject(new Error(`whisper-cli failed: ${err.message}`));
        } else {
          reject(new Error("whisper-cli produced no output."));
        }
      },
    );
  });
}

export function normalizeTranscript(text: string): string {
  let t = text.trim();
  // Whisper sometimes hallucinates these on silence/short audio
  const hallucinations = ["you", "thanks", "sorry", "okay", "um", "uh", "hmm"];
  const lower = t.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  if (hallucinations.includes(lower)) {
    return "";
  }
  // Strip leading filler words that whisper sometimes adds
  t = t.replace(/^(okay|um|uh|so|well)[,\s]+/i, "");
  return t.trim();
}

// ─── Simple truncation helper ────────────────────────────────────────────────
// Kept for unit tests; not used in any runtime path now that TTS is gone.

export function truncateForSpeech(text: string, maxChars: number = 300): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const slice = trimmed.slice(0, maxChars);
  const lastPeriod = slice.lastIndexOf(".");
  const lastQuestion = slice.lastIndexOf("?");
  const lastExclaim = slice.lastIndexOf("!");
  const boundary = Math.max(lastPeriod, lastQuestion, lastExclaim);

  if (boundary > maxChars * 0.5) {
    return slice.slice(0, boundary + 1);
  }
  return slice + "...";
}