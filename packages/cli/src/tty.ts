/** Ctrl+C / Ctrl+D at a hidden prompt. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

/** Read a line from the TTY without echoing it. Only call when stdin is a TTY. */
export function promptHidden(question: string): Promise<string> {
  const { stdin, stderr } = process;
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          finish();
          reject(new CancelledError());
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stderr.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** Read all of a piped stdin. Fails on more than `limit` bytes rather than buffering without bound. */
export async function readStdin(limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limit) throw new Error(`stdin is larger than ${limit} bytes`);
    chunks.push(buf);
  }
  const all = Buffer.concat(chunks);
  const text = all.toString("utf8");
  all.fill(0);
  for (const c of chunks) c.fill(0);
  return text;
}
