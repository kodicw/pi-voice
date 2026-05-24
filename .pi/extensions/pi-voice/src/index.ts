/**
 * pi-voice ≥2.0 — Local speech-to-text and text-to-speech for pi
 *
 * /voice            Record → transcribe (whisper.cpp) → send user message
 * /voice-diagnose   Health check every subsystem
 * /voice-settings   Toggle auto-TTS, TL;DR, configure models
 * /speak            Read last assistant message aloud (piper → espeak)
 *
 * STT:  whisper.cpp (local)  → OpenRouter (fallback)
 * TTS:  piper-tts (local)    → espeak-ng (fallback)
 * TL;DR: OpenRouter (cloud)  → simple truncation (fallback)
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { unlinkSync } from "node:fs";
import { cpus } from "node:os";
import { summarizeText } from "./openrouter.js";
import {
  cleanupRecordingDir,
  detectAudioBackends,
  ensureWav,
  getTempPath,
  playWav,
  readFileBase64,
  speakViaEspeak,
  startRecording,
  stopRecording,
} from "./audio.js";
import { humanizeForSpeech } from "./humanize.js";
import {
  detectPiper,
  detectWhisper,
  normalizeTranscript,
  speakWithPiper,
  transcribeWithWhisper,
  truncateForSpeech,
  type PiperStatus,
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
let piper: PiperStatus = detectPiper();
let activeCtx: ExtensionContext | undefined;
let pendingSpeakRequest = false;

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

// ─── Auth (OpenRouter — only for summarization) ─────────────────────────────

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

// ─── Commander: notify safe ─────────────────────────────────────────────────

function notify(
  ctx: ExtensionCommandContext,
  msg: string,
  type: "info" | "error" | "warning" = "info",
): void {
  if (ctx.hasUI) {
    try {
      ctx.ui.notify(msg, type);
    } catch (err: any) {
      console.error(`[pi-voice] notify failed: ${type}: ${msg} —`, err.message);
    }
  }
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
    notify(
      ctx,
      "[pi-voice] No recorder found. Install: ffmpeg, sox, alsa-utils, or pipewire.",
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
    notify(ctx, `[pi-voice] Failed to create temp file: ${err.message}`, "error");
    return;
  }

  // Start recording
  let recState: ReturnType<typeof startRecording>;
  try {
    recState = startRecording(audio.recorder!, outPath, maxSeconds);
    currentRecording = recState;
  } catch (err: any) {
    notify(ctx, `[pi-voice] Failed to start ${recorderName}: ${err.message}`, "error");
    return;
  }

  if (!recState.process || recState.process.killed) {
    currentRecording = null;
    notify(
      ctx,
      `[pi-voice] ${recorderName} exited immediately. Check microphone is plugged in, not muted, and accessible. Try: ${recorderName} --help`,
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
                : `Recording ${elapsedSec.toFixed(1)}s / ${maxSeconds}s`;
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
    notify(ctx, `[pi-voice] Overlay error: ${err.message}`, "error");
    return;
  }

  // Stop recorder
  let recordedPath: string;
  try {
    recordedPath = await stopRecording(recState);
    currentRecording = null;
  } catch (err: any) {
    currentRecording = null;
    notify(ctx, `[pi-voice] Error stopping recorder: ${err.message}`, "error");
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
    notify(ctx, "Recording cancelled.", "info");
    return;
  }
  if (!userAction || (userAction !== "stop" && userAction !== "cancel")) {
    try {
      cleanupRecordingDir(recordedPath);
    } catch { /* */ }
    notify(
      ctx,
      "[pi-voice] Recorder exited unexpectedly. Check microphone permissions.",
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
      notify(
        ctx,
        `[pi-voice] ${recorderName} produced empty file. Mic may be muted, wrong device, or ALSA/PipeWire not running. Try /voice-diagnose.`,
        "error",
      );
    } else {
      notify(
        ctx,
        "[pi-voice] Recording too short (<1KB). Try speaking louder or closer.",
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
    notify(
      ctx,
      `[pi-voice] Audio conversion failed: ${err.message}. Install ffmpeg or sox.`,
      "error",
    );
    return;
  }

  // Transcribe
  let transcript: string;
  ctx.ui.setWorkingMessage("Transcribing...");
  ctx.ui.setWorkingVisible(true);

  try {
    if (whisper.available) {
      const rawTranscript = transcribeWithWhisper(wavPath, whisper);
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
    ctx.ui.setWorkingVisible(false);
    notify(
      ctx,
      `[pi-voice] STT failed: ${err.message}. ${
        whisper.available
          ? "whisper.cpp error — check model file."
          : "OpenRouter error — check API key and model."
      }`,
      "error",
    );
    return;
  } finally {
    ctx.ui.setWorkingVisible(false);
  }

  if (!transcript || !transcript.trim()) {
    notify(
      ctx,
      "[pi-voice] No clear speech detected — too quiet, too short, or unintelligible. Try speaking louder or closer to the mic.",
      "warning",
    );
    return;
  }

  // Send as user message
  const preview =
    transcript.trim().substring(0, 80) + (transcript.length > 80 ? "..." : "");
  notify(ctx, `🎙️ "${preview}"`, "info");
  try {
    // If streaming, queue as followUp instead of throwing
    if (ctx.isIdle && !ctx.isIdle()) {
      pi.sendUserMessage(transcript.trim(), { deliverAs: "followUp" });
    } else {
      pi.sendUserMessage(transcript.trim());
    }
  } catch (err: any) {
    notify(ctx, `[pi-voice] Failed to send message: ${err.message}`, "error");
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
  piper = detectPiper();

  // --- Recorder ---
  if (audio.canRecord && audio.recorder) {
    push(`Recorder: ${audio.recorder.cmd}`);
  } else {
    push(
      "No recorder. Install: sox (rec), alsa-utils (arecord), ffmpeg, or pipewire (pw-record)",
      "fail",
    );
  }

  // --- Player ---
  if (audio.canPlay && audio.player) {
    push(`Player: ${audio.player.cmd}`);
  } else {
    push(
      "No player. TTS playback won't work. Install: aplay, pw-play, ffplay, mpv, or sox",
      "warn",
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

  // --- Piper (neural TTS) ---
  if (piper.available) {
    push(`Piper TTS: ${piper.voiceName}`);
  } else if (piper.cli) {
    push(
      "piper found but no voice model. Run: setup-voice-models (or download manually to ~/.local/share/piper/)",
      "warn",
    );
  } else {
    push(
      "piper not found. Neural TTS unavailable. Install piper-tts for better voice quality.",
      "warn",
    );
  }

  // --- Espeak (fallback TTS) ---
  if (audio.hasEspeak) {
    let version = "espeak";
    try {
      const out = execFileSync("espeak-ng", ["--version"], {
        encoding: "utf8",
        timeout: 2000,
      });
      const rawVersion = out.split("\n")[0];
      version = rawVersion ? rawVersion.trim() : "espeak-ng";
    } catch { /* */ }
    push(`Fallback TTS: ${version}`);
  } else {
    push("espeak-ng not found. No TTS fallback available.", "warn");
  }

  // --- OpenRouter (summarization only) ---
  const hasKey = await hasOpenRouterKey(ctx);
  if (hasKey) {
    push("OpenRouter: key present (for TL;DR summarization)");
  } else {
    push(
      "OpenRouter: no key. TL;DR mode will use simple truncation instead. Run /login openrouter to enable cloud summarization.",
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

  if (piper.available && audio.canPlay && audio.player) {
    try {
      const wavPath = await speakWithPiper("pi voice test", piper);
      await playWav(wavPath, audio.player);
      try { unlinkSync(wavPath); } catch { /* */ }
      push("Piper TTS test: OK — you should have heard 'pi voice test'");
    } catch (err: any) {
      push(`Piper TTS test failed: ${err.message}`, "warn");
    }
  } else if (audio.hasEspeak && audio.canPlay && audio.player) {
    try {
      await speakViaEspeak("pi voice test", audio.player, 200);
      push("Espeak TTS test: OK — you should have heard 'pi voice test'");
    } catch (err: any) {
      push(`Espeak TTS test failed: ${err.message}`, "warn");
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
    console.log(`  autoTts:          ${settings.autoTts}`);
    console.log(`  tldrMode:         ${settings.tldrMode}`);
    console.log(`  sttModel:         ${settings.sttModel}`);
    console.log(`  summaryModel:     ${settings.summaryModel}`);
    console.log(`  maxRecordSeconds: ${settings.maxRecordSeconds}`);
    console.log(`  language:         ${settings.language}`);
    return;
  }

  type Item = { id: keyof VoiceSettings; label: string; value: string };

  const items: Item[] = [
    { id: "autoTts", label: "Auto TTS", value: String(settings.autoTts) },
    { id: "tldrMode", label: "TL;DR mode", value: String(settings.tldrMode) },
    { id: "sttModel", label: "STT model (cloud fallback)", value: settings.sttModel },
    { id: "summaryModel", label: "Summary model", value: settings.summaryModel },
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
              if (item.id === "autoTts" || item.id === "tldrMode") {
                (settings as any)[item.id] =
                  editBuffer.toLowerCase() === "true";
              } else if (item.id === "maxRecordSeconds") {
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
            if (item.id === "autoTts" || item.id === "tldrMode") {
              (settings as any)[item.id] = !(settings as any)[item.id];
              item.value = String((settings as any)[item.id]);
            } else {
              editing = true;
              editBuffer = String((settings as any)[item.id]);
            }
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
    notify(ctx, "Voice settings saved.", "info");
  }
}

// ─── Overlay: Speaking ───────────────────────────────────────────────────

async function showSpeakingOverlay(
  ctx: ExtensionCommandContext,
  speechText: string,
  wavPath: string,
): Promise<void> {
  const startTime = Date.now();
  let playbackDone = false;

  playWav(wavPath, audio.player!).then(function () {
    playbackDone = true;
  }).catch(function () {
    playbackDone = true;
  });

  await ctx.ui.custom(
    function (_tui, theme, _kb, done) {
      var closed = false;

      var checkDone = setInterval(function () {
        if (playbackDone && !closed) {
          closed = true;
          clearInterval(checkDone);
          done(undefined);
        }
      }, 200);

      return {
        render: function (_width: number): string[] {
          var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          var preview = speechText.substring(0, 120) + (speechText.length > 120 ? "..." : "");
          var lines: string[] = [
            theme.fg("accent", theme.bold("🔊 Speaker")),
            "",
            playbackDone
              ? theme.fg("green", "✓ Done speaking")
              : "Playing... (" + elapsed + "s)",
            "",
          ];
          lines.push(theme.fg("dim", preview));
          lines.push("");
          lines.push(theme.fg("dim", playbackDone ? "Auto-closing..." : "Esc to stop"));
          return lines;
        },
        invalidate: function () {},
        handleInput: function (data: string) {
          if (matchesKey(data, "escape") && !closed) {
            closed = true;
            clearInterval(checkDone);
            done(undefined);
          }
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "top-right", width: "38%" } },
  );
}

// ─── Auto-TTS + /speak ──────────────────────────────────────────────────────

async function handleAgentEnd(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  showOverlay?: boolean,
): Promise<string | undefined> {
  if (!settings.autoTts && !pendingSpeakRequest) return;

  // Extract last assistant text
  var lastAssistantText = "";
  try {
    var branch = ctx.sessionManager.getBranch();
    for (var i = branch.length - 1; i >= 0; i--) {
      var entry = branch[i];
      if (entry.type === "message" && entry.message && entry.message.role === "assistant") {
        var content = entry.message.content;
        if (typeof content === "string") {
          lastAssistantText = content;
        } else if (Array.isArray(content)) {
          var texts: string[] = [];
          for (var j = 0; j < content.length; j++) {
            var part = content[j];
            if (part && typeof part === "object" && (part as any).type === "text") {
              var rawText = (part as any).text;
              if (rawText) texts.push(rawText);
            }
          }
          lastAssistantText = texts.join("\n");
        }
        break;
      }
    }
  } catch (err: any) {
    notify(
      ctx as any,
      "[pi-voice] Failed to read conversation: " + err.message,
      "error",
    );
    return;
  }

  if (!lastAssistantText.trim()) return;

  var textToSpeak = lastAssistantText.trim();

  // TL;DR via OpenRouter, or simple truncation
  if (settings.tldrMode) {
    var summarized = false;
    try {
      var apiKey = await resolveOpenRouterKey(ctx);
      var tldr = await summarizeText(apiKey, lastAssistantText, settings.summaryModel);
      if (tldr && tldr.trim()) {
        textToSpeak = tldr.trim();
        summarized = true;
      }
    } catch {
      /* fall through to truncation */
    }
    if (!summarized) {
      textToSpeak = truncateForSpeech(lastAssistantText, 300);
    }
  }

  // Speak via piper → espeak fallback (humanize text first)
  try {
    piper = detectPiper(); // refresh
    var speechText = humanizeForSpeech(textToSpeak);
    if (!speechText.trim()) {
      notify(ctx as any, "Nothing to speak after cleaning.", "warning");
      return speechText;
    }
    if (piper.available && audio.canPlay && audio.player) {
      var wavPath = await speakWithPiper(speechText, piper);
      if (showOverlay && ctx.hasUI) {
        await showSpeakingOverlay(ctx as any, speechText, wavPath);
      } else {
        await playWav(wavPath, audio.player);
      }
      try { unlinkSync(wavPath); } catch { /* */ }
    } else if (audio.hasEspeak && audio.canPlay && audio.player) {
      await speakViaEspeak(speechText, audio.player, 175);
    }
    return speechText;
  } catch (err: any) {
    notify(ctx as any, "TTS failed: " + err.message, "warning");
  }
}

// ─── Extension Entry ────────────────────────────────────────────────────────

export default function piVoiceExtension(pi: ExtensionAPI): void {
  audio = detectAudioBackends();
  whisper = detectWhisper();
  piper = detectPiper();

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
    description: "Test recorder, player, whisper, piper, espeak, and OpenRouter",
    handler: async (_args, ctx) => {
      await runVoiceDiagnose(pi, ctx);
    },
  });

  pi.registerCommand("voice-settings", {
    description: "Configure voice/TTS settings",
    handler: async (_args, ctx) => {
      await runVoiceSettings(pi, ctx);
    },
  });

  pi.registerCommand("speak", {
    description: "Read the last assistant message aloud (TTS)",
    handler: async (_args, ctx) => {
      pendingSpeakRequest = true;
      try {
        await handleAgentEnd(pi, ctx as unknown as ExtensionContext);
      } finally {
        pendingSpeakRequest = false;
      }
    },
  });

  pi.on("agent_end", async () => {
    if (!activeCtx) return;
    await runAsyncSafe(() => handleAgentEnd(pi, activeCtx!));
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
  if (piper.available) parts.push("piper ✓");
  else if (audio.hasEspeak) parts.push("espeak ✓");
  else parts.push("tts ✗");

  try {
    const hasKey = await hasOpenRouterKey(ctx);
    parts.push(hasKey ? "cloud ✓" : "cloud —");
  } catch {
    parts.push("cloud —");
  }

  notify(
    ctx as any,
    `Voice: ${parts.join(" | ")}  •  /voice-diagnose for details`,
    "info",
  );
}

async function runAsyncSafe(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    console.error("[pi-voice] auto-TTS error:", e.message);
  }
}
