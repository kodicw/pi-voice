# Task: Fix Message Queuing During TTS Playback

## Problem
After the refactoring, pi-voice's auto-TTS (triggered by the `agent_end` event) still causes user messages to queue. If the user types a new message while TTS is playing back from a previous response, the new message doesn't get processed until TTS finishes.

## Root Cause
The `agent_end` event handler is registered as `async`:

```typescript
pi.on("agent_end", async () => {
  if (!activeCtx) return;
  await runAsyncSafe(() => handleAutoTts(activeCtx!));
});
```

Pi likely awaits all `agent_end` handlers (even ones that resolve quickly) before it can process the next user input. Even though `handleAutoTts` calls `enqueueTts` (which returns immediately), the async event handler creates a microtask that delays pi's input loop.

## Required Fix

1. Make the `agent_end` handler **completely synchronous** — remove `async`/`await` from the handler registration
2. Use `setImmediate()` to defer the auto-TTS logic to the **next event loop tick**, so pi can process user input before TTS starts

The handler should become:

```typescript
pi.on("agent_end", () => {
  setImmediate(() => {
    if (!activeCtx || !settings.autoTts) return;
    const text = extractAssistantText(activeCtx);
    if (!text) return;
    piper = detectPiper();
    audio = detectAudioBackends();
    enqueueTts(async () => {
      await speakText(text, makeSpeakOptions(activeCtx));
    });
  });
});
```

This ensures:
- The `agent_end` handler is synchronous (no `async`) — pi can immediately process the next user input
- The TTS logic fires on the **next event loop tick** via `setImmediate`, well after the `agent_end` event resolves
- The TTS queue itself is unchanged — it already processes tasks serially in the background

## Steps

1. Edit `/home/kodicw/code/pi-voice/.pi/extensions/pi-voice/src/index.ts` — change the `agent_end` registration as shown above
2. Run tests: `npx vitest run` and `npx tsc --noEmit`
3. Verify the fix works: the user should be able to type/send a message to pi while TTS is still playing from the previous response, and the message should be processed immediately (not wait for TTS to finish)

## Files
- `/home/kodicw/code/pi-voice/.pi/extensions/pi-voice/src/index.ts` — main extension file, where `agent_end` is registered (around line 493)
- `/home/kodicw/code/pi-voice/.pi/extensions/pi-voice/src/tts-queue.ts` — TTS queue (unchanged)
- `/home/kodicw/code/pi-voice/.pi/extensions/pi-voice/src/local.ts` — Local STT/TTS
