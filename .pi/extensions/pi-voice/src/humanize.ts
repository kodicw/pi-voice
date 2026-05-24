/**
 * Humanize assistant text for speech synthesis.
 *
 * Strips markdown, removes special chars that TTS would read aloud,
 * and rewrites structural elements into spoken English.
 */

const URL_RE = /https?:\/\/[^\s)\\]+/g;
const CODE_RE = /`([^`]+)`/g;
const BOLD_RE = /\*\*([^*]+)\*\*/g;
const ITALIC_RE = /\*([^*]+)\*/g;
const HEADING_RE = /#{1,6}\s+(.*)/g;
const HR_RE = /^(---+|===+|\*\*\*+)\s*$/gm;
const BULLET_RE = /^\s*[-*]\s+/gm;
const NUMBER_RE = /^\s*\d+\.\s+/gm;
const BLOCKQUOTE_RE = /^\s*>\s*/gm;
const TABLE_RE = /\|/g;
const EMOJI_RE = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
const ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!|])/g;

export function humanizeForSpeech(text: string): string {
  let t = text;

  // Strip emoji (most TTS engines read them as "grinning face" or worse)
  t = t.replace(EMOJI_RE, " ");

  // Un-escape markdown chars: \* → *
  t = t.replace(ESCAPE_RE, "$1");

  // Headings → plain text with a slight pause hint (period)
  t = t.replace(HEADING_RE, "... $1. ");

  // Horizontal rules → silence
  t = t.replace(HR_RE, " ... ");

  // Inline code → just the content, with a verbal cue if short
  t = t.replace(CODE_RE, (_m, code) => {
    const c = code.trim();
    if (c.length < 3) return c; // single chars, just speak it
    if (c.length < 20) return `code: ${c}`;
    return "some code. ";
  });

  // Bold / italic → plain words
  t = t.replace(BOLD_RE, "$1");
  t = t.replace(ITALIC_RE, "$1");

  // Bullet points → spoken list cues
  const lines = t.split("\n");
  let inList = false;
  let listCount = 0;
  const outLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const isBullet = BULLET_RE.test(line);
    const isNumber = NUMBER_RE.test(line);

    // Reset regex lastIndex (global flag)
    BULLET_RE.lastIndex = 0;
    NUMBER_RE.lastIndex = 0;

    if (isBullet) {
      if (!inList) {
        inList = true;
        listCount = 0;
      }
      listCount++;
      const content = line.replace(BULLET_RE, "").trim();
      if (content) {
        const prefix = listCount === 1 ? "first, " : "next, ";
        outLines.push(prefix + content);
      }
      continue;
    }

    if (isNumber) {
      if (!inList) inList = true;
      const content = line.replace(NUMBER_RE, "").trim();
      if (content) {
        outLines.push(content);
      }
      continue;
    }

    if (inList && line.trim() === "") {
      inList = false;
      listCount = 0;
      continue;
    }

    inList = false;
    listCount = 0;

    // Blockquote
    if (BLOCKQUOTE_RE.test(line)) {
      line = line.replace(BLOCKQUOTE_RE, "").trim();
    }
    BLOCKQUOTE_RE.lastIndex = 0;

    // Tables → strip pipes, keep cell content with pauses
    if (TABLE_RE.test(line) && line.includes("|")) {
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c.length > 0 && !/^[-:]+$/.test(c));
      if (cells.length > 0) {
        outLines.push(cells.join(". ") + ".");
      }
      continue;
    }
    TABLE_RE.lastIndex = 0;

    if (line.trim()) {
      outLines.push(line);
    }
  }

  t = outLines.join("\n");

  // URLs → say "link" or domain name
  t = t.replace(URL_RE, (url) => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      return `link to ${host}`;
    } catch {
      return "a link";
    }
  });

  // Remove leftover markdown brackets for links: [text](url) → text
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remaining stray markdown chars
  t = t.replace(/([*_~`])/g, " ");

  // Multiple spaces / newlines → single space
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{2,}/g, "\n");
  t = t.replace(/\n/g, " ");

  // Smart cleanup of punctuation runs
  t = t.replace(/\.{3,}/g, "...");
  t = t.replace(/\.+\s*\./g, "... ");
  t = t.replace(/\s+/g, " ");

  return t.trim();
}
