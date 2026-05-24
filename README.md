# pi-voice 🎙️

**Local speech-to-text and text-to-speech** for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).

- **STT**: Speak to your agent — whisper.cpp transcribes locally
- **TTS**: Hear responses read aloud via neural piper-tts (or espeak-ng fallback)
- **Auto-summary**: Optionally TL;DR long responses before speaking
- **100% local**: No cloud needed for voice I/O. Only OpenRouter summarization is optional.

## Install

```bash
# From GitHub
pi install git:github.com/kodicw/pi-voice

# Or from a local checkout
cd ~/code/pi-voice
pi install .

# Verify
pi
# Expected: "pi-voice" in [Extensions] banner
```

> Requires `whisper-cpp`, `piper-tts`, and `espeak-ng` in your PATH.  
> On NixOS: `nix develop` in the extension directory, or add them to `home.packages`.

## Quick Start

```bash
# 1. Start pi in your project
pi

# 2. Run diagnostics
/voice-diagnose

# 3. Record and send speech
/voice

# 4. Toggle settings
/voice-settings
```

## Commands

| Command | Description |
|---------|-------------|
| `/voice` | Record audio → transcribe → send as your message |
| `/voice-diagnose` | Test every subsystem (recorder, whisper, piper, auth) |
| `/voice-settings` | Toggle auto-TTS, TL;DR, configure models |
| `/speak` | Read the last assistant response aloud |

## Features

- **Smart humanizer** — Strips markdown, emoji, URLs, code blocks, and tables from TTS output so speech sounds natural
- **Hallucination guard** — Filters common whisper.cpp silence hallucinations ("you", "sorry", "thanks") before they reach your conversation
- **Auto-TTS** — Automatically reads each assistant response after the agent finishes
- **TL;DR mode** — Summarizes long responses with OpenRouter before speaking (falls back to truncation)
- **Settings persistence** — Changes survive across sessions
- **Nix flake** — Full `flake.nix` for reproducible dependency management

## Architecture

```
/voice
  record  →  whisper.cpp  →  normalizeTranscript  →  pi.sendUserMessage()

agent_end
  extract text → humanizeForSpeech → piper-tts (neural) → pw-play
                                     ↓ (fallback)
                                   espeak-ng

TL;DR (optional)
  OpenRouter summarize → or → truncateForSpeech (when offline)
```

| Component | Primary | Fallback |
|-----------|---------|----------|
| Speech-to-Text | **whisper.cpp** (local) | OpenRouter `/audio/transcriptions` |
| Text-to-Speech | **piper-tts** (neural local) | espeak-ng |
| Summarization | OpenRouter (cloud) | Character truncation |

## Performance

| Metric | Before | After |
|--------|--------|-------|
| STT latency (2s audio) | ~3.0s (4 threads, beam=5) | **~1.8s** (8 threads, beam=1) |
| Recording size | ~92KB/s (44.1kHz) | **~33KB/s** (16kHz native) |
| WAV conversion | Required resampling | **No-op** (native 16kHz) |

## Requirements

- **pi-coding-agent** v0.75+
- **Audio backend**: PipeWire (pw-record/pw-play), ALSA (arecord/aplay), sox, or ffmpeg
- **STT**: `whisper-cpp` + a `ggml-*.bin` model
- **TTS**: `piper-tts` + an `.onnx` voice model; or `espeak-ng`
- **Summarization** (optional): OpenRouter API key (`/login openrouter` or `OPENROUTER_API_KEY`)

## File Structure

```
.pi/extensions/pi-voice/
├── flake.nix             # Nix dependencies + model downloaders
├── package.json          # Extension manifest
├── README.md             # Detailed extension docs
└── src/
    ├── index.ts          # Commands, auto-TTS, settings
    ├── audio.ts          # Recorder/player detection & helpers
    ├── local.ts          # Whisper + piper backends
    ├── openrouter.ts     # Cloud STT + summarization fallback
    ├── humanize.ts       # Speech-friendly text cleaning
    └── types.ts          # Shared types & defaults
```

## License

MIT
