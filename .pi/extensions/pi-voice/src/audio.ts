/**
 * Audio backend detection and helpers.
 * Detects available tools for recording, playing, and synthesizing audio.
 *
 * Performance notes:
 * - pw-record records at 16 kHz (whisper native) to skip conversion
 * - All recorders output WAV so ensureWav is a no-op
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioBackends, AudioPlayer, AudioRecorder, RecordingState } from "./types.js";
import { detectPiper } from "./local.js";

/** Whisper's native sample rate — recording at this avoids resampling */
const TARGET_RATE = "16000";

/** Check if a command exists in PATH */
export function hasCmd(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "pipe", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** Detect available audio backends */
export function detectAudioBackends(): AudioBackends {
  const hasFfmpeg = hasCmd("ffmpeg");
  const hasFfplay = hasCmd("ffplay");
  const hasSox = hasCmd("sox");
  const hasRec = hasCmd("rec");
  const hasArecord = hasCmd("arecord");
  const hasAplay = hasCmd("aplay");
  const havePulse = hasCmd("pactl");
  const hasPacat = hasCmd("pacat");
  const havePipewire = hasCmd("pw-record");
  const hasPwPlay = hasCmd("pw-play");
  const hasEspeakNg = hasCmd("espeak-ng");
  const hasEspeak = hasCmd("espeak");
  const hasMpv = hasCmd("mpv");
  const hasPaplay = hasCmd("paplay");

  let recorder: AudioRecorder | null = null;

  if (havePipewire) {
    // Record at whisper's native 16 kHz — 2.75x smaller files, no resampling
    recorder = {
      cmd: "pw-record",
      args: (out, _dur) => [
        "--rate", TARGET_RATE,
        "--channels", "1",
        "--format", "s16",
        out,
      ],
      ext: "wav",
    };
  } else if (hasSox || hasRec) {
    const cmd = hasRec ? "rec" : "sox";
    recorder = {
      cmd,
      args: (out, dur) => [
        "-t", "alsa", "default",
        "-r", "16000", "-c", "1", "-b", "16",
        out,
        ...(dur ? ["trim", "0", String(dur)] : []),
      ],
      ext: "wav",
    };
  } else if (hasFfmpeg) {
    recorder = {
      cmd: "ffmpeg",
      args: (out, dur) => [
        "-f", "alsa", "-i", "default",
        "-ar", "16000", "-ac", "1",
        ...(dur ? ["-t", String(dur)] : []),
        "-y", out,
      ],
      ext: "wav",
    };
  } else if (hasArecord) {
    recorder = {
      cmd: "arecord",
      args: (out, dur) => [
        "-f", "S16_LE", "-r", "16000", "-c", "1",
        ...(dur ? ["-d", String(dur)] : []),
        out,
      ],
      ext: "wav",
    };
  } else if (havePulse && hasPacat) {
    recorder = {
      cmd: "pacat",
      args: (out, dur) => [
        "--record",
        "-d", "0",
        "--rate=16000",
        "--format=s16le",
        "--channels=1",
        ...(dur ? ["--latency-msec", String(dur * 1000)] : []),
        "-o", out,
      ],
      ext: "raw",
    };
  }

  let player: AudioPlayer | null = null;

  if (hasPwPlay) {
    player = { cmd: "pw-play", args: (f) => [f] };
  } else if (hasPaplay) {
    player = { cmd: "paplay", args: (f) => [f] };
  } else if (hasAplay) {
    player = { cmd: "aplay", args: (f) => [f] };
  } else if (hasFfplay) {
    player = { cmd: "ffplay", args: (f) => ["-nodisp", "-autoexit", "-loglevel", "error", f] };
  } else if (hasMpv) {
    player = { cmd: "mpv", args: (f) => ["--no-video", "--really-quiet", f] };
  } else if (hasSox) {
    player = { cmd: "sox", args: (f) => [f, "-d"] };
  }

  return {
    canRecord: recorder !== null,
    canPlay: player !== null,
    recorder,
    player,
    hasEspeak: hasEspeakNg || hasEspeak,
    hasPiper: detectPiper().available,
  };
}

/** Build a temp path for recordings */
export function getTempPath(ext: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-voice-"));
  return join(dir, `recording.${ext}`);
}

/**
 * Start recording audio.
 * If the recorder process hangs, a watchdog SIGKILLs it after maxSeconds+5s.
 */
export function startRecording(
  recorder: AudioRecorder,
  outputPath: string,
  maxSeconds?: number,
): RecordingState {
  const args = recorder.args(outputPath, maxSeconds);
  const proc = spawn(recorder.cmd, args, {
    stdio: "ignore",
    detached: false,
  });

  const state: RecordingState = {
    startTime: Date.now(),
    outputPath,
    process: proc,
    manuallyStopped: false,
  };

  // Watchdog: absolute kill after maxSeconds + 5 seconds
  const killDeadline = (maxSeconds !== undefined ? maxSeconds : 300) * 1000 + 5000;
  const watchdog = setTimeout(() => {
    if (state.process && !state.process.killed) {
      try {
        state.process.kill("SIGKILL");
      } catch { /* */ }
    }
  }, killDeadline);

  proc.on("exit", (code, signal) => {
    clearTimeout(watchdog);
    state.process = null;
    if (state.onExit) {
      state.onExit(signal, code);
    }
  });

  proc.on("error", () => {
    clearTimeout(watchdog);
    state.process = null;
    if (state.onExit) {
      state.onExit(null, -1);
    }
  });

  return state;
}

/**
 * Stop recording.
 * SIGTERM then SIGKILL after 750ms if still alive.
 * Returns a Promise that resolves once the process has fully exited.
 */
export function stopRecording(state: RecordingState): Promise<string> {
  state.manuallyStopped = true;

  return new Promise((resolve) => {
    if (!state.process) {
      resolve(state.outputPath);
      return;
    }

    const proc = state.process;
    state.process = null;

    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve(state.outputPath);
    };

    proc.on("exit", finish);
    proc.on("error", finish);

    // Hard-kill watchdog
    const timeout = setTimeout(() => {
      if (!proc.killed) {
        try { proc.kill("SIGKILL"); } catch { /* */ }
      }
      finish();
    }, 1000);

    try { proc.kill("SIGTERM"); } catch { finish(); }
  });
}

/** Read a file as base64 */
export function readFileBase64(path: string): string {
  return readFileSync(path).toString("base64");
}

/** Convert audio to WAV if needed, returning the WAV path */
export function ensureWav(inputPath: string, ext: string): string {
  if (ext === "wav") return inputPath;

  const wavPath = inputPath.replace(/\.[^.]+$/, ".wav");

  if (hasCmd("ffmpeg")) {
    execFileSync("ffmpeg", [
      "-f", "s16le", "-ar", "16000", "-ac", "1",
      "-i", inputPath,
      "-y", wavPath,
    ], { stdio: "ignore", timeout: 10000 });
    try { unlinkSync(inputPath); } catch { /* */ }
    return wavPath;
  }

  if (hasCmd("sox")) {
    execFileSync("sox", [
      "-t", "raw", "-r", "16000", "-b", "16", "-e", "signed", "-c", "1",
      inputPath,
      wavPath,
    ], { stdio: "ignore", timeout: 10000 });
    try { unlinkSync(inputPath); } catch { /* */ }
    return wavPath;
  }

  throw new Error("Cannot convert raw audio to WAV. Install ffmpeg or sox.");
}

/** Play a WAV file */
export function playWav(path: string, player: AudioPlayer): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(player.cmd, player.args(path), { stdio: "ignore" });
    proc.on("close", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`${player.cmd} exited with ${code}`));
    });
    proc.on("error", reject);
  });
}

/** Generate and play TTS via espeak */
export async function speakViaEspeak(text: string, player?: AudioPlayer, speed: number = 175): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = hasCmd("espeak-ng") ? "espeak-ng" : "espeak";
    const tmpWav = join(tmpdir(), `pi-voice-tts-${Date.now()}.wav`);

    const gen = spawn(cmd, ["-s", String(speed), "-w", tmpWav, text], {
      stdio: "ignore",
    });

    gen.on("close", async (code) => {
      if (code !== 0) {
        try { unlinkSync(tmpWav); } catch { /* */ }
        reject(new Error(`${cmd} exited with ${code}`));
        return;
      }

      try {
        if (player) {
          await playWav(tmpWav, player);
        }
        try { unlinkSync(tmpWav); } catch { /* */ }
        resolve();
      } catch (err) {
        try { unlinkSync(tmpWav); } catch { /* */ }
        reject(err);
      }
    });

    gen.on("error", reject);
  });
}

/** Cleanup temp recording directory */
export function cleanupRecordingDir(recordingPath: string) {
  try {
    const dir = recordingPath.substring(0, recordingPath.lastIndexOf("/"));
    if (dir && dir.startsWith(tmpdir())) {
      try { unlinkSync(recordingPath); } catch { /* */ }
      try { rmdirSync(dir); } catch { /* */ }
    }
  } catch { /* ignore */ }
}
