// What the message box does with `@file` and `/command` while the user types. Pure: the Composer
// component feeds it the text and the caret position.

export interface Trigger {
  kind: "mention" | "command";
  /** What was typed after the `@` or `/`, up to the caret. */
  query: string;
  /** The token being completed spans `start` to `end` of the text. */
  start: number;
  end: number;
}

/**
 * The `@file` or `/command` the caret is in, if any. A mention is a word that starts with `@` (so an
 * email address is not one); a command is the first word of the message, starting with `/`.
 */
export function activeTrigger(text: string, caret: number): Trigger | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1] as string)) start--;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end] as string)) end++;
  const word = text.slice(start, caret);
  if (word.startsWith("@")) {
    return { kind: "mention", query: word.slice(1).replace(/^"/, ""), start, end };
  }
  if (word.startsWith("/") && start === 0) return { kind: "command", query: word.slice(1), start, end };
  return null;
}

/** The text with the trigger's token replaced, a space after it, and where the caret goes. */
export function applyCompletion(text: string, trigger: Trigger, replacement: string): { text: string; caret: number } {
  const after = text.slice(trigger.end);
  const next = text.slice(0, trigger.start) + replacement + (after.startsWith(" ") ? "" : " ") + after;
  return { text: next, caret: trigger.start + replacement.length + 1 };
}

/** How a file is written into a message; a path with spaces is quoted. */
export function formatMention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}
