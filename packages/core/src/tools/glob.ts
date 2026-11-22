const SPECIAL = /[.+^$|()[\]\\{}]/g;

/**
 * Compiles a small glob into a RegExp over `/`-separated paths. Supports `*` (within a segment),
 * `**` (across segments), `?`, and `{a,b}` alternatives; every other character is literal.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      depth++;
      re += "(?:";
    } else if (c === "}" && depth > 0) {
      depth--;
      re += ")";
    } else if (c === "," && depth > 0) {
      re += "|";
    } else {
      re += c.replace(SPECIAL, "\\$&");
    }
  }
  if (depth > 0) throw new Error(`Invalid glob "${glob}": unclosed "{"`);
  return new RegExp(`^${re}$`);
}

/**
 * Whether `relPath` (relative to the search root, `/`-separated) matches `glob`. A glob without a
 * `/` matches the file name at any depth, like `*.ts`; one with a `/` matches the whole path.
 */
export function matchesGlob(glob: RegExp, hasSlash: boolean, relPath: string): boolean {
  if (hasSlash) return glob.test(relPath);
  return glob.test(relPath.slice(relPath.lastIndexOf("/") + 1));
}
