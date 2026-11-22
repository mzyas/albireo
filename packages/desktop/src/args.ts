/**
 * The folder named on the command line (`electron . <dir>` while developing, `albireo-desktop <dir>`
 * once packaged). Flags are skipped, Chromium's own included.
 */
export function workspaceArg(argv: readonly string[], defaultApp: boolean): string | undefined {
  // Unpackaged, argv is [electron, appPath, ...args]; packaged, it is [app, ...args].
  return argv.slice(defaultApp ? 2 : 1).find((arg) => arg !== "" && !arg.startsWith("-"));
}
