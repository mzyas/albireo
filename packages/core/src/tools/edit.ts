export interface EditOutcome {
  text: string;
  /** How many occurrences were replaced. */
  count: number;
  /** 1-based line of the first replaced occurrence. */
  line: number;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

function occurrences(text: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) at.push(i);
  return at;
}

/**
 * Replaces `oldString` with `newString` in `text`. Without `replaceAll` the match must be unique, so
 * an edit never lands somewhere the model did not mean. Throws a message meant for the model.
 *
 * Models write `\n` even for files with CRLF endings; when the file uses CRLF and the strings carry
 * no `\r`, they are converted so the edit matches and the file keeps its line endings.
 */
export function applyEdit(text: string, oldString: string, newString: string, replaceAll = false): EditOutcome {
  if (oldString === "") throw new Error("old_string must not be empty. Use write_file to create or overwrite a file.");
  if (oldString === newString)
    throw new Error("old_string and new_string are identical, so there is nothing to change.");

  if (text.includes("\r\n") && !oldString.includes("\r")) {
    oldString = oldString.replace(/\n/g, "\r\n");
    newString = newString.replace(/\r?\n/g, "\r\n");
  }

  const at = occurrences(text, oldString);
  if (at.length === 0) {
    throw new Error(
      "old_string was not found in the file. It must match exactly, including whitespace and indentation; read the file again and copy the text.",
    );
  }
  if (at.length > 1 && !replaceAll) {
    const lines = at.slice(0, 8).map((i) => lineOf(text, i));
    throw new Error(
      `old_string appears ${at.length} times (lines ${lines.join(", ")}${at.length > lines.length ? ", …" : ""}). ` +
        "Include more surrounding context to make it unique, or set replace_all to change every occurrence.",
    );
  }

  const first = at[0] as number;
  let out = "";
  let from = 0;
  for (const i of replaceAll ? at : [first]) {
    out += text.slice(from, i) + newString;
    from = i + oldString.length;
  }
  out += text.slice(from);
  return { text: out, count: replaceAll ? at.length : 1, line: lineOf(text, first) };
}
