# Usage: nix-shell shell.nix
{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    espeak-ng          # TTS synthesis
    alsa-utils         # arecord / aplay
    sox                # rec / play (universal audio tool)
    ffmpeg             # ffmpeg / ffplay (fallback)
  ];

  shellHook = ''
    echo "pi-voice dev shell ready."
    echo "Audio tools:"
    which espeak-ng arecord rec ffmpeg 2>/dev/null || true
  '';
}
