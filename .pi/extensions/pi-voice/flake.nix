{
  description = "pi-voice extension — local speech-to-text and text-to-speech for pi-coding-agent";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };

        # Script to download whisper.cpp models
        download-whisper-model = pkgs.writeShellScriptBin "download-whisper-model" ''
          set -euo pipefail
          MODEL_DIR="$HOME/.local/share/whisper"
          mkdir -p "$MODEL_DIR"

          # Default to base.en if no arg given
          MODEL=''${1:-base.en}

          URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
          OUT="$MODEL_DIR/ggml-$MODEL.bin"

          if [ -f "$OUT" ]; then
            echo "Model already exists: $OUT"
            exit 0
          fi

          echo "Downloading ggml-$MODEL.bin..."
          ${pkgs.curl}/bin/curl -L --fail --progress-bar "$URL" -o "$OUT"
          echo "Saved to $OUT"
        '';

        # Script to download any piper voice (from any language/quality tier)
        download-piper-voice = pkgs.writeShellScriptBin "download-piper-voice" ''
          set -euo pipefail
          VOICE_DIR="$HOME/.local/share/piper"
          mkdir -p "$VOICE_DIR"

          # Full voice identifier, e.g. en_US-lessac-high, en_GB-cori-high
          VOICE=''${1:-en_US-lessac-high}

          # Parse voice name: {locale}-{speaker}-{quality}
          # e.g. en_US-lessac-high  → LOCALE=en_US LANG=en SPEAKER=lessac QUALITY=high
          LOCALE="''${VOICE%%-*}"
          LANG="''${LOCALE%%_*}"
          REST="''${VOICE#''${LOCALE}-}"
          QUALITY="''${REST##*-}"
          SPEAKER="''${REST%-*}"

          BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/''${LANG}/''${LOCALE}/''${SPEAKER}/''${QUALITY}/''${VOICE}"
          ONNX_URL="''${BASE_URL}.onnx"
          JSON_URL="''${BASE_URL}.onnx.json"

          ONNX_OUT="$VOICE_DIR/''${VOICE}.onnx"
          JSON_OUT="$VOICE_DIR/''${VOICE}.onnx.json"

          if [ -f "$ONNX_OUT" ] && [ -f "$JSON_OUT" ]; then
            echo "Voice already exists: $VOICE_DIR/$VOICE"
            exit 0
          fi

          echo "Downloading $VOICE from HuggingFace..."
          echo "  Model: $ONNX_URL"
          echo "  Config: $JSON_URL"
          ${pkgs.curl}/bin/curl -L --fail --progress-bar "$ONNX_URL" -o "$ONNX_OUT"
          ${pkgs.curl}/bin/curl -L --fail --progress-bar "$JSON_URL" -o "$JSON_OUT"
          echo "Saved to $VOICE_DIR"
        '';

        # Script to list available piper voices for a language
        list-piper-voices = pkgs.writeShellScriptBin "list-piper-voices" ''
          set -euo pipefail
          LOCALE=''${1:-en_US}
          LANG="''${LOCALE%%_*}"

          echo "=== Available piper voices for $LOCALE ==="
          echo ""
          echo "Download with: download-piper-voice {voice-name}"
          echo ""

          # Fetch the voices page and grep for .onnx links
          ${pkgs.curl}/bin/curl -sL --fail \
            "https://huggingface.co/rhasspy/piper-voices/tree/main/''${LANG}/''${LOCALE}" 2>/dev/null \
            | ${pkgs.gnugrep}/bin/grep -oE 'href="[^"]+\.onnx"' \
            | ${pkgs.gnused}/bin/sed 's/href="//;s/\.onnx"//' \
            | ${pkgs.gnused}/bin/sed 's|.*/||' \
            | sort -u \
            || echo "Could not fetch voice list. Visit: https://huggingface.co/rhasspy/piper-voices/tree/main/''${LANG}/''${LOCALE}"
        '';

        # Script to setup all default voice models
        setup-voice-models = pkgs.writeShellScriptBin "setup-voice-models" ''
          set -euo pipefail
          echo "=== pi-voice model setup ==="
          echo ""
          echo "Downloading whisper.cpp model (base.en, ~147MB)..."
          ${download-whisper-model}/bin/download-whisper-model base.en
          echo ""
          echo "Downloading piper voice (en_US-lessac-high, ~88MB)..."
          ${download-piper-voice}/bin/download-piper-voice en_US-lessac-high
          echo ""
          echo "Done! Models are in ~/.local/share/whisper and ~/.local/share/piper"
          echo ""
          echo "Other recommended piper voices (try: download-piper-voice <name>):"
          echo "  en_US-lessac-high   (default, female US, best quality)"
          echo "  en_US-ryan-high     (male US, best quality)"
          echo "  en_GB-cori-high     (female UK, best quality)"
        '';

      in
      {
        packages = {
          default = pkgs.symlinkJoin {
            name = "pi-voice";
            paths = [
              download-whisper-model
              download-piper-voice
              list-piper-voices
              setup-voice-models
            ];
          };
        };

        devShells.default = pkgs.mkShell {
          name = "pi-voice";

          buildInputs = with pkgs; [
            # STT
            whisper-cpp

            # TTS
            piper-tts
            espeak-ng

            # Audio I/O
            pipewire
            alsa-utils
            sox
            ffmpeg

            # Model download helpers
            download-whisper-model
            download-piper-voice
            list-piper-voices
            setup-voice-models

            # Dev
            nodejs_latest
          ];

          shellHook = ''
            echo "🎤 pi-voice dev shell ready"
            echo ""
            echo "Local tools:"
            echo "  STT:  $(which whisper-cli 2>/dev/null || echo 'whisper-cli not found')"
            echo "  TTS:  $(which piper 2>/dev/null || echo 'piper not found')"
            echo "  TTS:  $(which espeak-ng 2>/dev/null || echo 'espeak-ng not found')"
            echo ""
            echo "Model setup:"
            echo "  setup-voice-models    # Download whisper + default piper voice (~240MB)"
            echo "  download-piper-voice en_US-ryan-high   # Try a different voice"
            echo "  list-piper-voices en_US               # List available voices"
            echo ""
            echo "Quick start:"
            echo "  pi --mode tui         # Run pi with voice extension"
          '';
        };
      });
}
