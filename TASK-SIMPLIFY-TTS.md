# Task: Simplify pi-voice TTS — Remove Auto-TTS & Summarization

## Repo
`/home/kodicw/code/pi-voice/` — a pi extension for voice input/output.
Source: `.pi/extensions/pi-voice/src/`

## Goal
Simplify the TTS pipeline. The user wants:
1. **NO auto-speech-to-text** — remove the automatic TTS-after-agent-response entirely. All TTS must be invoked ONLY via the `/speak` slash command.
2. **NO summarization, no summary model** — remove all TL;DR / summarization logic and the `summaryModel` setting. No model is involved in TTS at all.
3. `/speak` should instead **read the last couple (2) of assistant messages** as-is (after humanizing), concatenated.

## Progress already done
- `src/types.ts` already updated: removed `tldrMode` and `summaryModel` from `VoiceSettings` interface and `DEFAULT_SETTINGS`. `autoTts` default changed to `false`. **Verify this is correct.**

## Changes still needed

### `src/tts-queue.ts`
- Remove from `SpeakOptions`: `tldrMode`, `summarizedText`, `summarize`.
- In `speakText()`: remove the summarization step entirely. The pipeline becomes simply:
  - truncate if too long (keep `truncateMaxChars` fallback, default 300)
  - humanize for speech (`humanizeForSpeech`)
  - play via piper → espeak fallback
- Remove the `"summarizing"` status emission (keep `"speaking"`, `"done"`, `"empty"`).
- Update the file's header doc comment to reflect the simplified pipeline (no summarize step).

### `src/index.ts`
- Remove `import { summarizeText } from "./openrouter.js"` (keep the dynamic import of `transcribeAudio` for STT fallback).
- **Remove the entire `pi.on("agent_end", ...)` auto-TTS handler** — the block at the bottom of `piVoiceExtension`. Auto-TTS is gone.
- Remove `lastUICtx` tracking and its assignments in command handlers IF it's only used by auto-TTS. (Check — if `/speak` and other commands don't need it, remove it.)
- Remove `resolveSummaryModel()` and `getEffectiveSummaryModel()` functions.
- Update `makeSpeakOptions()` — remove `tldrMode` and `summarize`. It should only pass `audio` and `piper`.
- Replace `extractAssistantText(ctx)` usage in `handleSpeakCommand` with a new function `extractLastAssistantMessages(ctx, count = 2)` that walks the session branch backwards, collects the last `count` assistant messages, and returns them joined with a blank line separator (`"\n\n"`). If none found, return `undefined`.
- Simplify `handleSpeakCommand()`:
  - Get last 2 assistant messages
  - If none, notify "No assistant messages to speak."
  - Show "Speaking..." overlay (no "Summarizing..." step, no summary model display)
  - Call `speakText(text, { audio, piper, onStatus })`
  - Clean up overlay on done/error
- Update `runVoiceSettings()`:
  - Remove the `tldrMode` settings item
  - Remove the `summaryModel` settings item
  - Keep: `autoTts` (still useful? **Actually, since auto-TTS is removed, autoTts setting is now meaningless — REMOVE it too**), `sttModel`, `maxRecordSeconds`, `language`
  - Remove the print-mode block that references `tldrMode`/`summaryModel`/`getEffectiveSummaryModel`
- Update the `runVoiceDiagnose()` OpenRouter line — it currently says "for TL;DR summarization". Change to note OpenRouter is only for STT fallback now. Remove the `tl;dr`/`cloud summarization` wording.
- Update the top file doc comment: remove the "TL;DR: OpenRouter (cloud) → simple truncation (fallback)" line and mention auto-TTS is removed.

### `src/types.ts`
- Since auto-TTS is removed, **remove `autoTts` from `VoiceSettings`** and `DEFAULT_SETTINGS`. (Verify nothing else references it.)
- Remove `localMode` too IF it's unused. (Check references first — if unused, remove.)

### `src/openrouter.ts`
- Remove `summarizeText()` export IF it's no longer used anywhere. Keep `transcribeAudio`.
- Update any doc comment.

## Important constraints
- **Run `nix develop` first** — the Nix dev shell provides tooling. Actually this is a TypeScript/Node pi extension, not the prophunt Python project. Use `npx vitest run` for tests and `npx tsc --noEmit` for type checks. Don't run `nix develop` unless needed.
- **All user-facing feedback MUST be top-right overlays only** — use the existing `showTopRightStatus` / `notifyTopRight` helpers. No `ctx.ui.notify()`, no user-visible `console.log`.
- Keep `resolveOpenRouterKey` and `hasOpenRouterKey` — they're still needed for the STT fallback (OpenRouter transcribeAudio).
- Do NOT touch the `/voice` command recording/transcription flow — it works.
- Do NOT touch `showTopRightStatus` or the AbortController dismiss logic — it was just fixed.
- Do NOT change `turbo` mode or other unrelated features.

## Build/verify commands
```bash
cd /home/kodicw/code/pi-voice
npx vitest run           # all 32 tests must pass
npx tsc --noEmit         # type check clean
```

## Commit & deploy
When done and tests pass:
```bash
cd /home/kodicw/code/pi-voice
git add -A
git commit -m "refactor(tts): remove auto-TTS and summarization; /speak reads last 2 messages"
git push
pi install git:github.com/kodicw/pi-voice
```

Then verify the install succeeded. Report back with: commit hash, test results, and a summary of files changed.