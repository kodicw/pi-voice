# Task: Make pi-voice Non-Blocking

You are working in `/home/kodicw/code/pi-voice` — the pi-voice extension repo.

## Problem

pi-voice provides voice commands for pi (speech-to-text and text-to-speech).
The problem: it **BLOCKS** the agent from responding while recording, transcribing, or speaking.

## Current Blocking Issues

1. **STT (`transcribeWithWhisper` in `local.ts`)**: Uses `execFileSync` (synchronous child_process) — blocks the entire Node.js event loop during transcription.

2. **Auto-TTS (`handleAgentEnd` in `index.ts`)**: The `agent_end` hook runs TTS playback (piper/espeak) synchronously before returning — blocks the next agent turn.

3. **`/voice` command**: Recording + transcribing + sending runs as one blocking sequence in `runVoiceCommand`.

## Requirements

1. **STT (`transcribeWithWhisper`)**: Convert from `execFileSync` to `execFile` wrapped in a Promise so transcription runs async/non-blocking.

2. **Auto-TTS (`handleAgentEnd`)**: Fire TTS playback in the background — return immediately from `agent_end` so the agent can start the next turn while audio plays out.

3. **`/voice` command**: Run the transcribe + send pipeline without blocking the agent.

4. **`/speak` command**: Same — fire-and-forget playback.

5. **TDD approach**: Write tests first for any new async behavior. Keep coverage for existing sync code where unchanged. Test files go in a `tests/` directory.

6. **No duplicate logic**: Factor out shared patterns between `/voice` and the auto-TTS pipeline. If the same transcription or TTS logic appears in multiple places, extract it once.

7. **Fire-and-forget pattern**: Use a simple background queue or spawn TTS playback without awaiting it in agent lifecycle hooks.

## Important Considerations

- Use proper error handling for the async paths — don't let background failures crash the agent.
- Dependencies: the extension uses only Node.js built-in modules + child_process calls to whisper.cpp/piper/espeak — no external npm deps.
- The pi `ExtensionAPI`/`ExtensionContext` types are in `@earendil-works/pi-coding-agent` (dev dep only).
- Read ALL source files fully before starting (they're in `.pi/extensions/pi-voice/src/`).
- Plan your changes, then implement them one by one with tests.
