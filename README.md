# pi-voice 🎙️

**Local speech-to-text** for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).

- **STT**: Speak to your agent — whisper.cpp transcribes locally
- **100% local**: No cloud needed for voice input. OpenRouter is an optional STT fallback.

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

> Requires `whisper-cpp` in your PATH and a recorder (`pw-record`, `rec`/`sox`, `arecord`, or `ffmpeg`).  
> On NixOS: `nix develop` in the extension directory, or add them to `home.packages`.

## Quick Start

```bash
# 1. Start pi in your project
pi

# 2. Run diagnostics
/voice-diagnose

# 3. Record and send speech
/voice

# 4. Configure settings (STT model, record duration, language)
/voice-settings
```

## Commands

| Command | Description |
|---------|-------------|
| `/voice` | Record audio → transcribe → send as your message |
| `/voice-diagnose` | Test every subsystem (recorder, whisper, OpenRouter) |
| `/voice-settings` | Configure STT model, max recording duration, language |

## Features

- **Hallucination guard** — Filters common whisper.cpp silence hallucinations ("you", "sorry", "thanks") before they reach your conversation
- **Non-blocking overlays** — Status notifications appear top-right and auto-dismiss; they never block keyboard input
- **Settings persistence** — Changes survive across sessions
- **Nix flake** — Full `flake.nix` for reproducible dependency management

## Architecture

```
/voice
  record  →  whisper.cpp  →  normalizeTranscript  →  pi.sendUserMessage()
```

| Component | Primary | Fallback |
|-----------|---------|----------|
| Speech-to-Text | **whisper.cpp** (local) | OpenRouter `/audio/transcriptions` (cloud) |

## Performance

| Metric | Before | After |
|--------|--------|-------|
| STT latency (2s audio) | ~3.0s (4 threads, beam=5) | **~1.8s** (8 threads, beam=1) |
| Recording size | ~92KB/s (44.1kHz) | **~33KB/s** (16kHz native) |
| WAV conversion | Required resampling | **No-op** (native 16kHz) |

## Requirements

- **pi-coding-agent** v0.75+
- **Audio backend**: PipeWire (pw-record), ALSA (arecord), sox, or ffmpeg
- **STT**: `whisper-cpp` + a `ggml-*.bin` model
- **STT fallback** (optional): OpenRouter API key (`/login openrouter` or `OPENROUTER_API_KEY`)

## File Structure

```
.pi/extensions/pi-voice/
├── flake.nix             # Nix dependencies + model downloaders
├── package.json          # Extension manifest
├── README.md             # Detailed extension docs
└── src/
    ├── index.ts          # Commands, settings
    ├── audio.ts          # Recorder detection & helpers
    ├── local.ts          # Whisper backend
    ├── openrouter.ts     # Cloud STT fallback
    └── types.ts          # Shared types & defaults
```

## License

MIT