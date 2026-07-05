import { describe, it, expect } from "vitest";
import { humanizeForSpeech } from "../.pi/extensions/pi-voice/src/humanize.ts";

describe("humanizeForSpeech", () => {
  it("strips bold markdown", () => {
    expect(humanizeForSpeech("hello **world**")).toBe("hello world");
  });

  it("strips italic markdown", () => {
    expect(humanizeForSpeech("hello *world*")).toBe("hello world");
  });

  it("transforms headings into plain text", () => {
    expect(humanizeForSpeech("# Hello World")).toBe("... Hello World.");
  });

  it("replaces URLs with domain names", () => {
    expect(humanizeForSpeech("visit https://example.com/path")).toBe(
      "visit link to example.com",
    );
  });

  it("handles empty input", () => {
    expect(humanizeForSpeech("")).toBe("");
  });

  it("strips emoji", () => {
    expect(humanizeForSpeech("hello 😊 world")).toBe("hello world");
  });

  it("preserves simple plain text", () => {
    expect(humanizeForSpeech("Hello world. This is a test.")).toBe(
      "Hello world. This is a test.",
    );
  });
});
