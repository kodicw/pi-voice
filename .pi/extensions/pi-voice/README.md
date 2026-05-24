# pi-voice

Local speech-to-text and text-to-speech for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).

**100% local for STT + TTS.** OpenRouter is only used for cloud TL;DR summarization (optional — falls back to truncation).

## Commands

| Command | Description |
|---------|-------------|
| `/voice` | Record audio → transcribe with whisper.cpp → send as user message |
| `/voice-diagnose` | Test every subsystem (recorder, whisper, piper, espeak, auth) |
| `/voice-settings` | Configure auto-TTS, TL;DR, models, max duration |
| `/speak` | Read last assistant message aloud (on-demand) |

## Architecture

```
/voice
  record  →  whisper.cpp (local STT)  →  pi.sendUserMessage()
                                          ↓
/auto-TTS  ←  piper-tts (neural) or espeak-ng  ←  summarize (OpenRouter or truncate)
```

| Component | Local | Cloud Fallback |
|-----------|-------|----------------|
| STT | **whisper.cpp** | OpenRouter (if whisper unavailable) |
| TTS | **piper-tts** → **espeak-ng** | — |
| Summary | simple truncation | OpenRouter |

## Quick Start

### 1. Install dependencies (Nix)

Using the project's flake:

```bash
cd /path/to/pi-stt/.pi/extensions/pi-voice
nix develop          # enter shell with all tools
setup-voice-models   # download whisper + best piper voice (~240MB)
```

Or add to your Home Manager config permanently:

```nix
# home.packages
whisper-cpp
piper-tts
espeak-ng
```

Then download models and try different voices:

```bash
setup-voice-models                                    # default: en_US-lessac-high

# Try other great piper voices:
download-piper-voice en_US-ryan-high                  # male US, best quality
download-piper-voice en_GB-cori-high                  # female UK, best quality
download-piper-voice en_US-libritts-high              # alternative female US

# List all voices for a language:
list-piper-voices en_US
```

### Voice Recommendations

| Voice | Gender | Quality | Size | Notes |
|-------|--------|---------|------|-------|
| **en_US-lessac-high** | F | ⭐⭐⭐ | ~88MB | Default — best overall |
| **en_US-ryan-high** | M | ⭐⭐⭐ | ~88MB | Best male US |
| **en_GB-cori-high** | F | ⭐⭐⭐ | ~88MB | Best British |
| **en_US-libritts-high** | F | ⭐⭐⭐ | ~88MB | Alternative female |
| en_US-lessac-medium | F | ⭐⭐ | ~60MB | Lower quality |

The extension auto-detects whichever voice is in `~/.local/share/piper/` — no config needed.

### 2. Test

Run pi with the extension loaded:

```bash
pi --mode tui
```

Then inside pi:

```
/voice-diagnose    # verify everything works
/voice             # record and transcribe
```

## Dependencies

### Required
- **Node.js ≥18** — pi extension runtime
- **pi-coding-agent** — the host agent
- **pipewire** OR **alsa-utils** OR **sox** OR **ffmpeg** — audio recording
- **whisper.cpp** — local STT
- **piper-tts** OR **espeak-ng** — TTS playback

### Optional
- **OpenRouter API key** — for cloud TL;DR summarization. Run `/login openrouter` in pi or set `OPENROUTER_API_KEY`.

## Nix Flake

The `flake.nix` provides:

- `devShells.default` — development shell with all dependencies
- `packages.default` — helper scripts (`setup-voice-models`, `download-whisper-model`, `download-piper-voice`)
- Pure, reproducible builds — no impure `nixpkgs` references

```bash
nix develop .#default        # enter dev shell
nix run .#setup-voice-models # download models directly
```

## File Structure

```
.pi/extensions/pi-voice/
├── flake.nix              # Nix flake: dependencies + model downloaders
├── shell.nix              # Legacy nix-shell (for non-flake users)
├── package.json           # Extension manifest
├── README.md
└── src/
    ├── index.ts           # Extension entry point, commands, auto-TTS
    ├── audio.ts           # Recorder/player detection, WAV helpers
    ├── local.ts           # whisper.cpp + piper-tts bindings
    ├── openrouter.ts      # Cloud STT + summarization (fallback only)
    └── types.ts           # Shared types and defaults
```

## Settings Persistence

Settings are stored in the pi session tree (`voice-settings` custom entry) and survive between sessions. Toggle `/voice-settings` → change values → hit Escape to save.

### Defaults

```typescript
autoTts: true          // speak after every agent response
tldrMode: true         // summarize before speaking
sttModel: "openai/whisper-large-v3"  // cloud fallback only
summaryModel: "openai/gpt-4o-mini"
maxRecordSeconds: 60
language: "en"
```

## Troubleshooting

`/voice-diagnose` is your friend. It tests every subsystem independently and reports actionable next steps.

| Problem | Cause | Fix |
|---------|-------|-----|
| No recorder found | Missing audio backend | `nix develop` or install pipewire/alsa/sox |
| whisper-cli found, no model | Models not downloaded | `setup-voice-models` |
| Piper not found | Not installed | `nix develop` or install piper-tts |
| Empty recording file | Mic muted / wrong device | Check `pavucontrol` or `alsamixer`, try `/voice-diagnose` |
| TTS sounds robotic | Using espeak-ng or low quality piper model | Run `setup-voice-models` for `lessac-high`, or try `download-piper-voice en_US-ryan-high` / `en_GB-cori-high` |
| STT uses OpenRouter | whisper.cpp not configured | Run `setup-voice-models`, check `~/.local/share/whisper/` |

## License

MIT
