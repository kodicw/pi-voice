import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AudioBackends } from "../.pi/extensions/pi-voice/src/types.ts";
import type { PiperStatus } from "../.pi/extensions/pi-voice/src/local.ts";
import type { SpeakOptions } from "../.pi/extensions/pi-voice/src/tts-queue.ts";

// Mock the tts-queue module's dependencies
vi.mock("../.pi/extensions/pi-voice/src/humanize.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../.pi/extensions/pi-voice/src/humanize.ts")>();
  return {
    ...actual,
    humanizeForSpeech: vi.fn(),
  };
});

vi.mock("../.pi/extensions/pi-voice/src/local.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../.pi/extensions/pi-voice/src/local.ts")>();
  return {
    ...actual,
    speakWithPiper: vi.fn(),
    truncateForSpeech: vi.fn(),
  };
});

vi.mock("../.pi/extensions/pi-voice/src/audio.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../.pi/extensions/pi-voice/src/audio.ts")>();
  return {
    ...actual,
    playWav: vi.fn(),
    speakViaEspeak: vi.fn(),
  };
});

import { humanizeForSpeech } from "../.pi/extensions/pi-voice/src/humanize.ts";
import { speakWithPiper, truncateForSpeech } from "../.pi/extensions/pi-voice/src/local.ts";
import { playWav, speakViaEspeak } from "../.pi/extensions/pi-voice/src/audio.ts";

const defaultAudio: AudioBackends = {
  canRecord: false,
  canPlay: true,
  recorder: null,
  player: { cmd: "pw-play", args: (f: string) => [f] },
  hasEspeak: true,
  hasPiper: true,
};

const defaultPiper: PiperStatus = {
  available: true,
  cli: "piper",
  modelPath: "/model.onnx",
  configPath: "/model.onnx.json",
  voiceName: "en_US-lesslow-medium",
};

function makeOptions(overrides: Partial<SpeakOptions> = {}): SpeakOptions {
  return {
    audio: defaultAudio,
    piper: defaultPiper,
    truncateMaxChars: 300,
    ...overrides,
  };
}

// ─── Queue tests ────────────────────────────────────────────────────────────

describe("TTS queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the queue state by re-importing
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports queue functions", async () => {
    const mod = await import("../.pi/extensions/pi-voice/src/tts-queue.ts");
    expect(typeof mod.enqueueTts).toBe("function");
    expect(typeof mod.clearPendingTts).toBe("function");
    expect(typeof mod.getQueueLength).toBe("function");
    expect(typeof mod.isQueueRunning).toBe("function");
    expect(typeof mod.speakText).toBe("function");
  });

  it("enqueueTts accepts and runs a task", async () => {
    const mod = await import("../.pi/extensions/pi-voice/src/tts-queue.ts");
    const task = vi.fn().mockResolvedValue(undefined);
    mod.enqueueTts(task);

    // Give the microtask queue a tick to process
    await new Promise((r) => setTimeout(r, 10));
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("clearPendingTts removes queued tasks", async () => {
    const mod = await import("../.pi/extensions/pi-voice/src/tts-queue.ts");

    // Use a task that doesn't resolve immediately so the queue stays "running"
    let resolveTask1: () => void;
    const task1Promise = new Promise<void>((r) => { resolveTask1 = r!; });
    const task1 = vi.fn().mockReturnValue(task1Promise);
    const task2 = vi.fn().mockResolvedValue(undefined);

    mod.enqueueTts(task1);

    // task1 starts processing but hasn't resolved yet, so processQueue
    // is still in the while-loop → queue stays "running"
    await new Promise((r) => setTimeout(r, 5));

    // Now enqueue task2 — since running=true, processQueue won't re-enter
    mod.enqueueTts(task2);
    expect(mod.getQueueLength()).toBe(1);

    // Clear pending — task2 should be removed
    mod.clearPendingTts();
    expect(mod.getQueueLength()).toBe(0);

    // Let task1 finish so the queue settles
    resolveTask1!();
    await new Promise((r) => setTimeout(r, 5));
    expect(task1).toHaveBeenCalledTimes(1);
    expect(task2).not.toHaveBeenCalled();
  });

  it("errors in queued tasks are caught (do not reject)", async () => {
    const mod = await import("../.pi/extensions/pi-voice/src/tts-queue.ts");
    const failingTask = vi.fn().mockRejectedValue(new Error("TTS failed"));

    // Should not throw
    mod.enqueueTts(failingTask);
    await new Promise((r) => setTimeout(r, 10));
    expect(failingTask).toHaveBeenCalledTimes(1);
  });
});

// ─── speakText tests ────────────────────────────────────────────────────────

describe("speakText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("humanizes and plays text via piper", async () => {
    (humanizeForSpeech as ReturnType<typeof vi.fn>).mockReturnValue("hello world");
    (speakWithPiper as ReturnType<typeof vi.fn>).mockResolvedValue("/tmp/test.wav");
    (playWav as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const mod = await import("../.pi/extensions/pi-voice/src/tts-queue.ts");
    const result = await mod.speakText("Hello **world**", makeOptions());

    expect(humanizeForSpeech).toHaveBeenCalledWith("Hello **world**");
    expect(speakWithPiper).toHaveBeenCalledWith("hello world", defaultPiper);
    expect(playWav).toHaveBeenCalledWith("/tmp/test.wav", defaultAudio.player);
    expect(result).toBe("hello world");
  });

  it("falls back to espeak when piper fails", async () => {
    (humanizeForSpeech as ReturnType<typeof vi.fn>).mockReturnValue("hello world");
    (speakWithPiper as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("piper crash"));
    (speakViaEspeak as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const mod = await import("../.pi/extensions/pi-voice/src/tts-queue.ts");
    await mod.speakText("Hello world", makeOptions());

    expect(speakWithPiper).toHaveBeenCalled();
    expect(speakViaEspeak).toHaveBeenCalled();
  });

  it("uses espeak directly when piper is unavailable", async () => {
    (humanizeForSpeech as ReturnType<typeof vi.fn>).mockReturnValue("hello");
    (speakViaEspeak as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const mod = await import("../.pi/extensions/pi-voice/src/tts-queue.ts");
    const noPiper: PiperStatus = {
      available: false,
      cli: null,
      modelPath: null,
      configPath: null,
      voiceName: null,
    };
    await mod.speakText("Hello", makeOptions({ piper: noPiper }));

    expect(speakViaEspeak).toHaveBeenCalled();
    expect(speakWithPiper).not.toHaveBeenCalled();
  });

  it("returns empty string when humanized text is empty", async () => {
    (humanizeForSpeech as ReturnType<typeof vi.fn>).mockReturnValue("");

    const mod = await import("../.pi/extensions/pi-voice/src/tts-queue.ts");
    const result = await mod.speakText("   ", makeOptions());

    expect(result).toBe("");
    expect(speakWithPiper).not.toHaveBeenCalled();
    expect(speakViaEspeak).not.toHaveBeenCalled();
  });

  it("warns but does not throw when no player is available", async () => {
    (humanizeForSpeech as ReturnType<typeof vi.fn>).mockReturnValue("hello");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await import("../.pi/extensions/pi-voice/src/tts-queue.ts");
    const noPlayAudio: AudioBackends = { ...defaultAudio, canPlay: false, player: null };
    const result = await mod.speakText("Hello", makeOptions({ audio: noPlayAudio }));

    expect(result).toBe("hello");
    expect(speakWithPiper).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});
