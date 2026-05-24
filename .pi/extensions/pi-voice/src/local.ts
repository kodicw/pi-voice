/**
 * Local AI backends — no network required for STT/TTS.
 *
 * STT: whisper.cpp (whisper-cli)
 * TTS: piper-tts (neural) → espeak-ng (fallback)
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cpus } from "node:os";
import { hasCmd } from "./audio.js";

// ─── Performance config ─────────────────────────────────────────────────────

/** Use all available CPU cores (whisper default is 4). Contains to 1-16. */
const OPTIMAL_THREADS = (function getThreads(): number {
  let n = 4;
  try {
    const c = cpus();
    if (c && c.length > 0) n = c.length;
  } catch { /* */ }
  return Math.max(Math.min(n, 16), 1);
})();

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

export function transcribeWithWhisper(wavPath: string, status: WhisperStatus): string {
  if (!status.available || !status.cli || !status.modelPath) {
    throw new Error("whisper.cpp not configured. Run setup-voice-models or /voice-diagnose.");
  }

  const outPrefix = join(tmpdir(), `whisper-out-${Date.now()}`);
  const txtPath = outPrefix + ".txt";

  try {
    execFileSync(
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
        "--threads", String(OPTIMAL_THREADS), // use all cores (~36% faster)
        "--beam-size", "1",                   // greedy decode: ~12% faster
        "--best-of", "1",                     // single best candidate
      ],
      { stdio: "pipe", timeout: 120000, encoding: "utf8" },
    );
  } catch (err: any) {
    // whisper-cli may exit non-zero but still write output
    if (existsSync(txtPath)) {
      const text = readFileSync(txtPath, "utf8").trim();
      try { unlinkSync(txtPath); } catch { /* */ }
      if (text) return text;
    }
    throw new Error(`whisper-cli failed: ${err.message || err}`);
  }

  if (!existsSync(txtPath)) {
    throw new Error("whisper-cli produced no output.");
  }

  const text = readFileSync(txtPath, "utf8").trim();
  try { unlinkSync(txtPath); } catch { /* */ }
  return text;
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

const PIPER_MODEL_DIRS = [
  join(homedir(), ".local", "share", "piper"),
  join(homedir(), "piper-voices"),
  "/usr/share/piper",
  "/usr/local/share/piper",
];

export interface PiperStatus {
  available: boolean;
  cli: string | null;
  modelPath: string | null;
  configPath: string | null;
  voiceName: string | null;
}

export function detectPiper(): PiperStatus {
  const cli = hasCmd("piper") ? "piper" : null;
  if (!cli) return { available: false, cli: null, modelPath: null, configPath: null, voiceName: null };

  let best: PiperStatus | null = null;
  const qualityRank: Record<string, number> = { high: 3, medium: 2, low: 1, x_low: 0 };

  for (const dir of PIPER_MODEL_DIRS) {
    if (!existsSync(dir)) continue;
    try {
      const entries = execFileSync("ls", [dir], { encoding: "utf8", timeout: 2000 });
      for (const line of entries.split("\n")) {
        const file = line.trim();
        if (!file.endsWith(".onnx")) continue;
        const voiceName = file.replace(".onnx", "");
        const modelPath = join(dir, file);
        const configPath = modelPath.replace(".onnx", ".onnx.json");
        if (!existsSync(configPath)) continue;

        // Parse quality tier from voice name (last segment after dash)
        const parts = voiceName.split("-");
        const rawQuality = parts[parts.length - 1];
        const quality = rawQuality ? rawQuality.toLowerCase() : "medium";
        const rank = qualityRank[quality] || 1;

        const candidate: PiperStatus = {
          available: true,
          cli,
          modelPath,
          configPath,
          voiceName,
        };

        // Compare with current best
        let bestRank = 0;
        if (best && best.voiceName) {
          const bestParts = best.voiceName.split("-");
          const bestRaw = bestParts[bestParts.length - 1];
          const bestQuality = bestRaw ? bestRaw.toLowerCase() : "medium";
          bestRank = qualityRank[bestQuality] || 1;
        }

        if (!best || rank > bestRank) {
          best = candidate;
        }
      }
    } catch { /* */ }
  }

  if (best) return best;
  return { available: false, cli, modelPath: null, configPath: null, voiceName: null };
}

export async function speakWithPiper(text: string, status: PiperStatus, speedScale: number = 1.0): Promise<string> {
  if (!status.available || !status.cli || !status.modelPath) {
    throw new Error("piper not configured. Run setup-voice-models or /voice-diagnose.");
  }

  const wavPath = join(tmpdir(), `piper-tts-${Date.now()}.wav`);

  return new Promise((resolve, reject) => {
    const proc = spawn(
      status.cli!,
      [
        "-m", status.modelPath!,
        "-c", status.configPath!,
        "-f", wavPath,
        "--length_scale", String(speedScale),
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`piper exited with ${code}`));
        return;
      }
      resolve(wavPath);
    });

    proc.stdin.write(text, "utf8");
    proc.stdin.end();
  });
}

// ─── Simple truncation (zero-dependency summary fallback) ────────────────────

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
