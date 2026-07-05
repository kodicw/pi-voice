import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeTranscript,
  truncateForSpeech,
} from "../.pi/extensions/pi-voice/src/local.ts";
import type { WhisperStatus } from "../.pi/extensions/pi-voice/src/local.ts";

// ─── normalizeTranscript ─────────────────────────────────────────────────────

describe("normalizeTranscript", () => {
  it("trims whitespace", () => {
    expect(normalizeTranscript("  hello world  ")).toBe("hello world");
  });

  it("returns empty string for known hallucinations", () => {
    const hallucinations = ["you", "thanks", "sorry", "okay", "um", "uh", "hmm"];
    for (const h of hallucinations) {
      expect(normalizeTranscript(h)).toBe("");
      expect(normalizeTranscript(h.toUpperCase())).toBe("");
    }
  });

  it("strips leading filler words", () => {
    expect(normalizeTranscript("okay let's try again")).toBe("let's try again");
    expect(normalizeTranscript("um, I think so")).toBe("I think so");
    expect(normalizeTranscript("so here's the plan")).toBe("here's the plan");
    expect(normalizeTranscript("well actually")).toBe("actually");
  });

  it("preserves normal speech", () => {
    expect(normalizeTranscript("Hello world this is a test")).toBe(
      "Hello world this is a test",
    );
  });

  it("handles empty string", () => {
    expect(normalizeTranscript("")).toBe("");
  });
});

// ─── truncateForSpeech ──────────────────────────────────────────────────────

describe("truncateForSpeech", () => {
  it("keeps short text unchanged", () => {
    expect(truncateForSpeech("hello world")).toBe("hello world");
  });

  it("truncates at sentence boundary when boundary is past 50% threshold", () => {
    const long = "A short sentence at the start. Then a much much much longer second part that pushes past the max chars threshold and should be dropped.";
    const result = truncateForSpeech(long, 50);
    expect(result).toBe("A short sentence at the start.");
  });

  it("adds ellipsis when no good sentence boundary found within 50%", () => {
    const long =
      "ThisIsAwordWithoutAnySentenceBoundariesThatGoesOnForQuiteSomeTimeAndHasNoPeriod";
    const result = truncateForSpeech(long, 20);
    expect(result).toContain("...");
    expect(result.length).toBeLessThanOrEqual(25);
  });

  it("respects maxChars parameter", () => {
    const text = "Hello world. This is a test. More here.";
    const result = truncateForSpeech(text, 10);
    expect(result).toBe("Hello worl...");
  });
});

// ─── transcribeWithWhisper (async) ──────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecFile = vi.mocked(execFile);

describe("transcribeWithWhisper", () => {
  const validStatus: WhisperStatus = {
    available: true,
    cli: "whisper-cli",
    modelPath: "/some/model.bin",
    modelName: "ggml-base.en.bin",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects when whisper is not available", async () => {
    const { transcribeWithWhisper } = await import(
      "../.pi/extensions/pi-voice/src/local.ts"
    );
    const status: WhisperStatus = {
      available: false,
      cli: null,
      modelPath: null,
      modelName: null,
    };
    await expect(transcribeWithWhisper("test.wav", status)).rejects.toThrow(
      "whisper.cpp not configured",
    );
  });

  it("rejects when modelPath is null", async () => {
    const { transcribeWithWhisper } = await import(
      "../.pi/extensions/pi-voice/src/local.ts"
    );
    const status: WhisperStatus = {
      available: true,
      cli: "whisper-cli",
      modelPath: null,
      modelName: null,
    };
    await expect(transcribeWithWhisper("test.wav", status)).rejects.toThrow(
      "whisper.cpp not configured",
    );
  });

  it("rejects on execFile error when no output file exists", async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFile.mockImplementation(((_cmd, _args, _opts, cb) => {
      cb(new Error("command failed"));
      return null as any;
    }) as any);

    const { transcribeWithWhisper } = await import(
      "../.pi/extensions/pi-voice/src/local.ts"
    );
    await expect(
      transcribeWithWhisper("test.wav", validStatus),
    ).rejects.toThrow("whisper-cli failed");
  });

  it("returns transcript from output file even when execFile errors", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("hello world\n");
    mockExecFile.mockImplementation(((_cmd, _args, _opts, cb) => {
      cb(new Error("non-zero exit"));
      return null as any;
    }) as any);

    const { transcribeWithWhisper } = await import(
      "../.pi/extensions/pi-voice/src/local.ts"
    );
    const result = await transcribeWithWhisper("test.wav", validStatus);
    expect(result).toBe("hello world");
  });

  it("resolves with transcript on success", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("transcribed text\n");
    mockExecFile.mockImplementation(((_cmd, _args, _opts, cb) => {
      cb(null);
      return null as any;
    }) as any);

    const { transcribeWithWhisper } = await import(
      "../.pi/extensions/pi-voice/src/local.ts"
    );
    const result = await transcribeWithWhisper("test.wav", validStatus);
    expect(result).toBe("transcribed text");
  });

  it("rejects when output file is empty after execFile succeeds", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("   \n");
    mockExecFile.mockImplementation(((_cmd, _args, _opts, cb) => {
      cb(null);
      return null as any;
    }) as any);

    const { transcribeWithWhisper } = await import(
      "../.pi/extensions/pi-voice/src/local.ts"
    );
    await expect(
      transcribeWithWhisper("test.wav", validStatus),
    ).rejects.toThrow("whisper-cli produced no output");
  });
});
