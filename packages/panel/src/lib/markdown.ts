const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * The lexer leaves entities in text tokens as they were written (`&amp;`). Text goes into the page
 * as text nodes, so decode them here. Unknown named entities stay as written.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

/** Model output is untrusted: only plain web and mail links become clickable. */
export function safeHref(href: string): string | null {
  const h = decodeEntities(href).trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}
