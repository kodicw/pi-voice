/**
 * pi-voice ≥2.0 — Local speech-to-text for pi
 *
 * /voice            Record → transcribe (whisper.cpp) → send user message
 * /voice-diagnose   Health check every subsystem
 * /voice-settings   Configure STT model, record duration, language
 *
 * STT:  whisper.cpp (local)  → OpenRouter (fallback)
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type OverlayHandle } from "@earendil-works/pi-tui";
import { statSync } from "node:fs";
import { cpus } from "node:os";
import {
  cleanupRecordingDir,
  detectAudioBackends,
  ensureWav,
  getTempPath,
  startRecording,
  stopRecording,
} from "./audio.js";
import {
  detectWhisper,
  normalizeTranscript,
  transcribeWithWhisper,
  type WhisperStatus,
} from "./local.js";
import { DEFAULT_SETTINGS, type VoiceSettings } from "./types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

/** Retry file stat every 100ms (instead of 250ms) — process exits fast */
const FILE_STAT_RETRY_MS = 100;
const FILE_STAT_RETRIES = 10;

// ─── State ──────────────────────────────────────────────────────────────────

let settings: VoiceSettings = { ...DEFAULT_SETTINGS };
let currentRecording: ReturnType<typeof startRecording> | null = null;
let audio = detectAudioBackends();
let whisper: WhisperStatus = detectWhisper();
let activeCtx: ExtensionContext | undefined;
// ─── Settings Persistence ───────────────────────────────────────────────────

function persistSettings(pi: ExtensionAPI): void {
  try {
    pi.appendEntry<VoiceSettings>("voice-settings", { ...settings });
  } catch (err: any) {
    console.error("[pi-voice] persistSettings failed:", err.message);
  }
}

function restoreSettings(_pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === "voice-settings") {
        const s = entry.data as Partial<VoiceSettings> | undefined;
        if (s) {
          settings = { ...DEFAULT_SETTINGS, ...s };
          return;
        }
      }
    }
  } catch (err: any) {
    console.error("[pi-voice] restoreSettings failed:", err.message);
  }
}

// ─── Auth (OpenRouter — only for STT fallback) ─────────────────────────────

async function resolveOpenRouterKey(
  ctx?: ExtensionContext | ExtensionCommandContext,
): Promise<string> {
  if (ctx && ctx.modelRegistry) {
    try {
      const key = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
      if (key) return key;
    } catch (err: any) {
      console.error("[pi-voice] modelRegistry.getApiKeyForProvider failed:", err.message);
    }
  }
  const env = process.env.OPENROUTER_API_KEY;
  if (env) return env;
  throw new Error(
    "No OpenRouter API key. Run /login openrouter, or set OPENROUTER_API_KEY.",
  );
}

async function hasOpenRouterKey(
  ctx?: ExtensionContext | ExtensionCommandContext,
): Promise<boolean> {
  try {
    await resolveOpenRouterKey(ctx);
    return true;
  } catch {
    return false;
  }
}

// ─── UI helpers (top-right overlays for all feedback) ──────────────────────────

/**
 * Tracks the last status overlay so we can dismiss it before showing a new one.
 * Holds the handle (for `hide()`) and the factory's `done` callback (to resolve the custom() promise).
 */
let lastDismissOverlay: (() => void) | null = null;
let lastOverlayHandle: OverlayHandle | undefined;
let lastOverlayDone: ((v: undefined) => void) | undefined;

/**
 * Show a temporary, non-blocking status overlay at the top-right.
 *
 * The overlay does NOT capture keyboard input (`nonCapturing: true`), so the
 * user can keep typing while it is visible. It auto-dismisses after `timeout` ms
 * and can also be dismissed early via the returned function — which is what
 * command handlers call the instant transcription / speaking finishes.
 *
 * NOTE: pi's `ctx.ui.custom()` options only accept `{ overlay, overlayOptions,
 * onHandle }`. There is no `signal` or `timeout` option — earlier code passed
 * those and they were silently ignored, which is why the overlay never
 * auto-dismissed and blocked input. We now pass `nonCapturing: true` in
 * `overlayOptions` and manage the timeout ourselves.
 */
function showTopRightStatus(
  ctx: ExtensionCommandContext,
  message: string,
  timeout: number = 5000,
): () => void {
  // Dismiss any previous overlay first
  if (lastDismissOverlay) {
    try { lastDismissOverlay(); } catch { /* */ }
    lastDismissOverlay = null;
    lastOverlayHandle = undefined;
    lastOverlayDone = undefined;
  }

  let timer: NodeJS.Timeout | undefined;
  let dismissed = false;

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    if (timer) { clearTimeout(timer); timer = undefined; }
    try { lastOverlayHandle?.hide(); } catch { /* */ }
    try { lastOverlayDone?.(undefined); } catch { /* */ }
    if (lastDismissOverlay === dismiss) lastDismissOverlay = null;
    lastOverlayHandle = undefined;
    lastOverlayDone = undefined;
  };

  if (ctx.hasUI) {
    ctx.ui.custom<string | undefined>(
      (_tui, theme, _kb, done) => {
        // Stash `done` so we can resolve the custom() promise from dismiss().
        lastOverlayDone = done as (v: undefined) => void;
        return {
          render(_width: number): string[] {
            return [
              theme.fg("accent", theme.bold("🎤 Voice")),
              "",
              message,
            ];
          },
          invalidate() {},
          // Non-capturing overlay: input flows to the editor regardless,
          // so this handler is intentionally a no-op (we never steal keys).
          handleInput(_data: string) {},
          dispose() {},
        };
      },
      {
        overlay: true,
        overlayOptions: { anchor: "top-right", width: "28%", nonCapturing: true },
        onHandle: (handle) => {
          lastOverlayHandle = handle;
          // If dismiss() raced ahead of onHandle, hide now.
          if (dismissed) { try { handle.hide(); } catch { /* */ } }
        },
      },
    ).then(() => {
      // Promise resolved (by our done() or by pi tearing it down). Clean up tracking.
      if (lastDismissOverlay === dismiss) lastDismissOverlay = null;
      lastOverlayHandle = undefined;
      lastOverlayDone = undefined;
    }).catch(() => {
      if (lastDismissOverlay === dismiss) lastDismissOverlay = null;
      lastOverlayHandle = undefined;
      lastOverlayDone = undefined;
    });

    // Safety-net timeout (pi's custom() has no built-in timeout option).
    timer = setTimeout(() => { try { dismiss(); } catch { /* */ } }, timeout);
  }

  lastDismissOverlay = dismiss;
  return dismiss;
}

/**
 * Show a brief notification overlay at the top-right that auto-dismisses (2.5s).
 */
function notifyTopRight(
  ctx: ExtensionCommandContext,
  msg: string,
  _type: "info" | "error" | "warning" = "info",
): void {
  showTopRightStatus(ctx, msg, 2500);
}



// ─── /voice ─────────────────────────────────────────────────────────────────

async function runVoiceCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  // Refresh detection (user may have installed deps mid-session)
  audio = detectAudioBackends();
  whisper = detectWhisper();

  if (!audio.canRecord) {
    notifyTopRight(
      ctx,
      "No recorder found. Install: ffmpeg, sox, alsa-utils, or pipewire.",
      "error",
    );
    return;
  }

  const maxSeconds = settings.maxRecordSeconds;
  let outPath: string;
  let recorderName: string;

  try {
    outPath = getTempPath(audio.recorder!.ext);
    recorderName = audio.recorder!.cmd;
  } catch (err: any) {
    notifyTopRight(ctx, `Failed to create temp file: ${err.message}`, "error");
    return;
  }

  // Start recording
  let recState: ReturnType<typeof startRecording>;
  try {
    recState = startRecording(audio.recorder!, outPath, maxSeconds);
    currentRecording = recState;
  } catch (err: any) {
    notifyTopRight(ctx, `Failed to start ${recorderName}: ${err.message}`, "error");
    return;
  }

  if (!recState.process || recState.process.killed) {
    currentRecording = null;
    notifyTopRight(
      ctx,
      `${recorderName} exited immediately. Check microphone.`,
      "error",
    );
    try {
      cleanupRecordingDir(outPath);
    } catch { /* */ }
    return;
  }

  const startTime = recState.startTime;

  // Overlay while recording
  let userAction: string | undefined;
  try {
    const rec = recState;
    userAction = await ctx.ui.custom<string | undefined>(
      (_tui, theme, _kb, done) => {
        let stopped = false;
        let autoResolved = false;

        const onProcExit = (_signal: NodeJS.Signals | null, code: number | null) => {
          if (stopped || autoResolved || rec.manuallyStopped) return;
          autoResolved = true;
          done(code === 0 || code === null ? "stop" : "cancel");
        };

        rec.onExit = onProcExit;

        return {
          render(_width: number): string[] {
            const elapsedSec = (Date.now() - startTime) / 1000;
            const status =
              stopped || autoResolved
                ? "Processing..."
                : `Listening... ${elapsedSec.toFixed(1)}s / ${maxSeconds}s`;
            return [
              theme.fg("accent", theme.bold("🎤 Voice Input")),
              "",
              status,
              "",
              theme.fg("dim", "Enter ▸ stop & send  •  Esc ▸ cancel"),
            ];
          },
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, "return")) {
              stopped = true;
              done("stop");
            } else if (matchesKey(data, "escape")) {
              stopped = true;
              done("cancel");
            }
          },
        };
      },
      { overlay: true, overlayOptions: { anchor: "top-right", width: "28%" } },
    );
  } catch (err: any) {
    try {
      await stopRecording(recState);
    } catch { /* */ }
    currentRecording = null;
    notifyTopRight(ctx, `Overlay error: ${err.message}`, "error");
    return;
  }

  // Stop recorder
  let recordedPath: string;
  try {
    recordedPath = await stopRecording(recState);
    currentRecording = null;
  } catch (err: any) {
    currentRecording = null;
    notifyTopRight(ctx, `Error stopping recorder: ${err.message}`, "error");
    try {
      cleanupRecordingDir(outPath);
    } catch { /* */ }
    return;
  }

  // Handle cancel
  if (userAction === "cancel") {
    try {
      cleanupRecordingDir(recordedPath);
    } catch { /* */ }
    notifyTopRight(ctx, "Recording cancelled.", "info");
    return;
  }
  if (!userAction || (userAction !== "stop" && userAction !== "cancel")) {
    try {
      cleanupRecordingDir(recordedPath);
    } catch { /* */ }
    notifyTopRight(
      ctx,
      "Recorder exited unexpectedly. Check microphone permissions.",
      "error",
    );
    return;
  }

  // Verify file (fast retry: 100ms x 10 = up to 1s)
  let fileSize = 0;
  let fileOk = false;
  for (let attempt = 0; attempt < FILE_STAT_RETRIES; attempt++) {
    try {
      const st = statSync(recordedPath);
      fileSize = st.size;
      if (fileSize >= 1024) {
        fileOk = true;
        break;
      }
    } catch {
      // still flushing
    }
    await new Promise((r) => setTimeout(r, FILE_STAT_RETRY_MS));
  }

  if (!fileOk) {
    try {
      cleanupRecordingDir(recordedPath);
    } catch { /* */ }
    if (fileSize === 0) {
      notifyTopRight(
        ctx,
        `${recorderName} produced empty file. Mic may be muted.`,
        "error",
      );
    } else {
      notifyTopRight(
        ctx,
        "Recording too short (<1KB). Try speaking louder.",
        "warning",
      );
    }
    return;
  }

  // Convert to WAV — now almost always a no-op since recorders output wav natively
  let wavPath: string;
  try {
    wavPath = ensureWav(recordedPath, audio.recorder!.ext);
  } catch (err: any) {
    try {
      cleanupRecordingDir(recordedPath);
    } catch { /* */ }
    notifyTopRight(
      ctx,
      `Audio conversion failed: ${err.message}. Install ffmpeg or sox.`,
      "error",
    );
    return;
  }

  // Transcribe
  let transcript: string;
  const transcribeMsg = whisper.available
    ? `Transcribing (whisper, ${whisper.modelName})...`
    : `Transcribing (OpenRouter, ${settings.sttModel})...`;
  const dismissTranscribe = showTopRightStatus(ctx, transcribeMsg, 10000);

  try {
    if (whisper.available) {
      const rawTranscript = await transcribeWithWhisper(wavPath, whisper);
      transcript = normalizeTranscript(rawTranscript);
    } else {
      // Fallback to OpenRouter STT
      const apiKey = await resolveOpenRouterKey(ctx);
      const base64 = readFileBase64(wavPath);
      const { transcribeAudio } = await import("./openrouter.js");
      transcript = await transcribeAudio(
        apiKey,
        base64,
        settings.sttModel,
        "wav",
        settings.language,
      );
    }
    try {
      cleanupRecordingDir(wavPath);
    } catch { /* */ }
  } catch (err: any) {
    try {
      cleanupRecordingDir(wavPath);
    } catch { /* */ }
    dismissTranscribe();
    notifyTopRight(
      ctx,
      `STT failed: ${err.message}. ${
        whisper.available
          ? "whisper.cpp error — check model file."
          : "OpenRouter error — check API key and model."
      }`,
      "error",
    );
    return;
  }

  dismissTranscribe();

  if (!transcript || !transcript.trim()) {
    notifyTopRight(
      ctx,
      "No clear speech detected — too quiet or unintelligible.",
      "warning",
    );
    return;
  }

  // Send as user message (no overlay — transcription appears as normal user message in conversation)
  try {
    // If streaming, queue as followUp instead of throwing
    if (ctx.isIdle && !ctx.isIdle()) {
      pi.sendUserMessage(transcript.trim(), { deliverAs: "followUp" });
    } else {
      pi.sendUserMessage(transcript.trim());
    }
  } catch (err: any) {
    notifyTopRight(ctx, `Failed to send message: ${err.message}`, "error");
  }
}

// ─── /voice-diagnose ────────────────────────────────────────────────────────

async function runVoiceDiagnose(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const lines: string[] = [];
  const ok: string[] = [];
  const fail: string[] = [];
  const warn: string[] = [];

  function push(msg: string, type: "ok" | "fail" | "warn" = "ok") {
    lines.push(
      type === "ok"
        ? `  ✅ ${msg}`
        : type === "fail"
          ? `  ❌ ${msg}`
          : `  ⚠️  ${msg}`,
    );
    if (type === "ok") ok.push(msg);
    else if (type === "fail") fail.push(msg);
    else warn.push(msg);
  }

  // Refresh detection
  audio = detectAudioBackends();
  whisper = detectWhisper();

  // --- Recorder ---
  if (audio.canRecord && audio.recorder) {
    push(`Recorder: ${audio.recorder.cmd}`);
  } else {
    push(
      "No recorder. Install: sox (rec), alsa-utils (arecord), ffmpeg, or pipewire (pw-record)",
      "fail",
    );
  }

  // --- Whisper (local STT) ---
  if (whisper.available) {
    const threadInfo = (function () {
      try {
        const n = cpus().length;
        return n > 4 ? ` (${n} threads)` : "";
      } catch {
        return "";
      }
    })();
    push(`Whisper STT: ${whisper.modelName}${threadInfo}`);
  } else if (whisper.cli) {
    push(
      "whisper-cli found but no model. Run: setup-voice-models (or download manually to ~/.local/share/whisper/)",
      "fail",
    );
  } else {
    push(
      "whisper-cli not found. Install whisper-cpp and run setup-voice-models.",
      "fail",
    );
  }

  // --- OpenRouter (STT fallback only) ---
  const hasKey = await hasOpenRouterKey(ctx);
  if (hasKey) {
    push("OpenRouter: key present (for STT fallback)");
  } else {
    push(
      "OpenRouter: no key. STT fallback to cloud unavailable. Run /login openrouter to enable.",
      "warn",
    );
  }

  // --- Smoke tests ---
  if (audio.canRecord && audio.recorder) {
    push("Testing 1-second recording...");
    let smoked: string | null = null;
    try {
      const p = getTempPath(audio.recorder.ext);
      const rec = startRecording(audio.recorder, p, 1);
      await new Promise((r) => setTimeout(r, 1200));
      smoked = await stopRecording(rec);
      const st = statSync(smoked);
      if (st.size >= 256) {
        push(`Recording test: OK (${st.size} bytes)`);
      } else {
        push(
          `Recording test: only ${st.size} bytes. Mic may be muted or wrong device.`,
          "warn",
        );
      }
      try {
        cleanupRecordingDir(smoked);
      } catch { /* */ }
    } catch (err: any) {
      if (smoked) try { cleanupRecordingDir(smoked); } catch { /* */ }
      push(`Recording test failed: ${err.message}`, "fail");
    }
  }

  // --- Summary ---
  lines.push("");
  if (!fail.length) {
    lines.push(
      ok.length >= 4
        ? "✅ All core checks passed. Voice is ready!"
        : "✅ Core checks passed. Warnings above are non-fatal.",
    );
  } else {
    lines.push(
      `⚠️  ${fail.length} fatal issue(s) found. Fix above to use /voice.`,
    );
  }

  if (ctx.hasUI) {
    await ctx.ui.custom(
      (_tui, theme, _kb, done) => ({
        render(_width: number): string[] {
          const header = theme.fg("accent", theme.bold("🔍 Voice Diagnose"));
          return [
            header,
            "",
            ...lines,
            "",
            theme.fg("dim", "Esc or Enter to close"),
          ];
        },
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, "escape") || matchesKey(data, "return")) {
            done(undefined);
          }
        },
      }),
      { overlay: true, overlayOptions: { anchor: "center", width: "55%" } },
    );
  } else {
    console.log(lines.join("\n"));
  }
}

// ─── /voice-settings ────────────────────────────────────────────────────────

async function runVoiceSettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    console.log("Voice Settings (print mode):");
    console.log(`  sttModel:         ${settings.sttModel}`);
    console.log(`  maxRecordSeconds: ${settings.maxRecordSeconds}`);
    console.log(`  language:         ${settings.language}`);
    return;
  }

  type Item = { id: keyof VoiceSettings; label: string; value: string };

  const items: Item[] = [
    { id: "sttModel", label: "STT model (cloud fallback)", value: settings.sttModel },
    { id: "maxRecordSeconds", label: "Max record (s)", value: String(settings.maxRecordSeconds) },
    { id: "language", label: "Language", value: settings.language },
  ];

  let selected = 0;
  let editing = false;
  let editBuffer = "";

  const result = await ctx.ui.custom<"saved" | undefined>(
    (_tui, theme, _kb, done) => {
      const render = (): string[] => {
        const out: string[] = [];
        out.push(theme.fg("accent", theme.bold("⚙️ Voice Settings")));
        out.push(
          theme.fg("dim", "↑↓ navigate • Enter toggle/edit • Esc save & close"),
        );
        out.push("");

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const isSel = i === selected;
          const prefix = isSel ? "▶ " : "  ";
          const label = isSel
            ? theme.fg("accent", item.label)
            : theme.fg("text", item.label);
          const displayVal =
            isSel && editing
              ? editBuffer + "█"
              : theme.fg("accent", item.value);
          const pad = Math.max(1, 20 - item.label.length);
          out.push(`${prefix}${label}:${" ".repeat(pad)}${displayVal}`);
        }

        out.push("");
        out.push(
          theme.fg(
            "dim",
            editing ? "Type value, Enter confirm, Esc cancel" : "",
          ),
        );
        return out;
      };

      return {
        render: () => render(),
        invalidate() {},
        handleInput(data: string) {
          if (editing) {
            if (matchesKey(data, "return")) {
              const item = items[selected];
              if (item.id === "maxRecordSeconds") {
                const n = parseInt(editBuffer, 10);
                if (!isNaN(n) && n > 0) (settings as any)[item.id] = n;
              } else {
                (settings as any)[item.id] = editBuffer;
              }
              item.value = String((settings as any)[item.id]);
              editing = false;
              editBuffer = "";
            } else if (matchesKey(data, "escape")) {
              editing = false;
              editBuffer = "";
            } else if (matchesKey(data, "backspace")) {
              editBuffer = editBuffer.slice(0, -1);
            } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
              editBuffer += data;
            }
            return;
          }

          if (matchesKey(data, "up")) {
            selected = Math.max(0, selected - 1);
          } else if (matchesKey(data, "down")) {
            selected = Math.min(items.length - 1, selected + 1);
          } else if (matchesKey(data, "return")) {
            const item = items[selected];
            editing = true;
            editBuffer = String((settings as any)[item.id]);
          } else if (matchesKey(data, "escape")) {
            done("saved");
          }
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "52%" } },
  );

  if (result === "saved") {
    persistSettings(pi);
    notifyTopRight(ctx, "Voice settings saved.", "info");
  }
}

// ─── Extension Entry ────────────────────────────────────────────────────────

export default function piVoiceExtension(pi: ExtensionAPI): void {
  audio = detectAudioBackends();
  whisper = detectWhisper();

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    restoreSettings(pi, ctx);
    await showStartupStatus(pi, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    activeCtx = ctx;
    restoreSettings(pi, ctx);
  });

  pi.registerCommand("voice", {
    description: "Record audio, transcribe (whisper.cpp), and send as user message",
    handler: async (_args, ctx) => {
      await runVoiceCommand(pi, ctx);
    },
  });

  pi.registerCommand("voice-diagnose", {
    description: "Test recorder, whisper, and OpenRouter STT",
    handler: async (_args, ctx) => {
      await runVoiceDiagnose(pi, ctx);
    },
  });

  pi.registerCommand("voice-settings", {
    description: "Configure voice settings",
    handler: async (_args, ctx) => {
      await runVoiceSettings(pi, ctx);
    },
  });

}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function showStartupStatus(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const parts: string[] = [];
  if (audio.canRecord) parts.push("rec ✓");
  else parts.push("rec ✗");
  if (whisper.available) parts.push("whisper ✓");
  else parts.push("whisper ✗");
  try {
    const hasKey = await hasOpenRouterKey(ctx);
    parts.push(hasKey ? "cloud ✓" : "cloud —");
  } catch {
    parts.push("cloud —");
  }

  try {
    // On session_start we don't have a UI-capable context, so just log
    console.log(`[pi-voice] ${parts.join(" | ")} — /voice-diagnose for details`);
  } catch { /* */ }
}

