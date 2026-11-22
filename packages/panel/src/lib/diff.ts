// Reads the unified diff `git diff` prints for one file into hunks of numbered lines. Pure: the diff view
// draws it as text nodes, never as HTML.

export type DiffLine =
  | { kind: "add"; text: string; newNo: number }
  | { kind: "del"; text: string; oldNo: number }
  | { kind: "ctx"; text: string; oldNo: number; newNo: number }
  /** `\ No newline at end of file`. */
  | { kind: "note"; text: string };

export interface Hunk {
  /** The `@@ -a,b +c,d @@ section` line. */
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: Hunk[];
  added: number;
  removed: number;
  binary: boolean;
  /** What the header says about the file as a whole: "new file", "deleted file", "renamed from x"… */
  notes: string[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(text: string): ParsedDiff {
  const out: ParsedDiff = { hunks: [], added: 0, removed: 0, binary: false, notes: [] };
  let hunk: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldMode = "?";

  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    const start = HUNK.exec(line);
    if (start) {
      hunk = { header: line, lines: [] };
      out.hunks.push(hunk);
      oldNo = Number(start[1]);
      newNo = Number(start[2]);
      continue;
    }
    if (line.startsWith("diff --git")) {
      hunk = undefined;
      continue;
    }
    if (hunk) {
      const mark = line[0];
      if (mark === "+") {
        hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
        out.added++;
      } else if (mark === "-") {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
        out.removed++;
      } else if (mark === "\\") {
        hunk.lines.push({ kind: "note", text: line.slice(1).trim() });
      } else {
        // A context line; some tools strip the single space from an empty one.
        hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      }
      continue;
    }

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) out.binary = true;
    else if (line.startsWith("new file mode")) out.notes.push("new file");
    else if (line.startsWith("deleted file mode")) out.notes.push("deleted file");
    else if (line.startsWith("rename from ")) out.notes.push(`renamed from ${line.slice("rename from ".length)}`);
    else if (line.startsWith("old mode ")) oldMode = line.slice("old mode ".length);
    else if (line.startsWith("new mode ")) out.notes.push(`mode ${oldMode} → ${line.slice("new mode ".length)}`);
  }
  return out;
}
