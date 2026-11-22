// What was typed in the message box and what waits to be sent, kept per session: switching to another
// session must not carry a half-written message, or a queued one, into the wrong conversation.

export interface ComposerMemory {
  text: string;
  /** Messages typed while a turn ran. They go out when their own session is shown and idle. */
  queue: string[];
}

const memory = new Map<string, ComposerMemory>();

export function remember(session: string, value: ComposerMemory): void {
  if (value.text === "" && value.queue.length === 0) memory.delete(session);
  else memory.set(session, { text: value.text, queue: [...value.queue] });
}

export function recall(session: string | null): ComposerMemory {
  const found = session ? memory.get(session) : undefined;
  return found ? { text: found.text, queue: [...found.queue] } : { text: "", queue: [] };
}
