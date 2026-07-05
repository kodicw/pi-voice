#!/usr/bin/env bash
# Launch agy with the pi-voice TTS simplification task.
set -e
cd /home/kodicw/code/pi-voice
PROMPT="Read the file TASK-SIMPLIFY-TTS.md in the current working directory and perform every change it describes in full. After making changes, run 'npx vitest run' and 'npx tsc --noEmit' to verify (all 32 tests must pass, type check clean). Then commit with message 'refactor(tts): remove auto-TTS and summarization; /speak reads last 2 messages', push, and run 'pi install git:github.com/kodicw/pi-voice'. Finally report: the commit hash, test results, and a summary of files changed."
exec agy --dangerously-skip-permissions -p "$PROMPT"