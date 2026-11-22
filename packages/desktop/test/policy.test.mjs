import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { workspaceArg } from "../dist/args.js";
import { pickFolder } from "../dist/folder.js";
import { PICK_DIRECTORY } from "../dist/ipc.js";
import { externalLink, grantsPermission, isPanelUrl, mayUseShell } from "../dist/policy.js";

const ORIGIN = "http://127.0.0.1:4321";

test("only the panel's own origin counts as the panel", () => {
  assert.equal(isPanelUrl(`${ORIGIN}/?token=abc`, ORIGIN), true);
  assert.equal(isPanelUrl(`${ORIGIN}/sessions`, ORIGIN), true);
  // Same host, other port; other host; other scheme; a lookalike host; not a URL at all.
  assert.equal(isPanelUrl("http://127.0.0.1:4322/", ORIGIN), false);
  assert.equal(isPanelUrl("http://localhost:4321/", ORIGIN), false);
  assert.equal(isPanelUrl("https://127.0.0.1:4321/", ORIGIN), false);
  assert.equal(isPanelUrl("http://127.0.0.1:4321.evil.example/", ORIGIN), false);
  assert.equal(isPanelUrl("http://127.0.0.1:4321@evil.example/", ORIGIN), false);
  assert.equal(isPanelUrl("not a url", ORIGIN), false);
  assert.equal(isPanelUrl("file:///C:/secret.txt", ORIGIN), false);
});

test("only web and mail links are handed to the system", () => {
  assert.equal(externalLink("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(externalLink("http://example.com/"), "http://example.com/");
  assert.equal(externalLink("mailto:someone@example.com"), "mailto:someone@example.com");
  for (const url of [
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "ms-msdt:/id PCWDiagnostic",
    "vscode://file/C:/x",
    "data:text/html,<script>1</script>",
    "C:\\Windows\\notepad.exe",
    "not a url",
    "",
  ]) {
    assert.equal(externalLink(url), null, url);
  }
});

test("the shell answers only the panel's own page", () => {
  assert.equal(mayUseShell(`${ORIGIN}/?token=abc`, ORIGIN), true);
  assert.equal(mayUseShell(undefined, ORIGIN), false);
  assert.equal(mayUseShell("https://example.com/", ORIGIN), false);
  assert.equal(mayUseShell("about:blank", ORIGIN), false);
});

test("the page gets the clipboard write and no other permission", () => {
  assert.equal(grantsPermission("clipboard-sanitized-write", `${ORIGIN}/`, ORIGIN), true);
  for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "openExternal", "fileSystem"]) {
    assert.equal(grantsPermission(permission, `${ORIGIN}/`, ORIGIN), false, permission);
  }
  assert.equal(grantsPermission("clipboard-sanitized-write", "https://example.com/", ORIGIN), false);
  assert.equal(grantsPermission("clipboard-sanitized-write", undefined, ORIGIN), false);
});

test("the folder picker returns the folder chosen, or null when cancelled", async () => {
  const folder = path.resolve("some", "folder");
  assert.equal(await pickFolder(async () => ({ canceled: false, filePaths: [folder] }), undefined), folder);
  assert.equal(await pickFolder(async () => ({ canceled: true, filePaths: [folder] }), undefined), null);
  assert.equal(await pickFolder(async () => ({ canceled: false, filePaths: [] }), undefined), null);
});

test("the picker opens where the page says only if that is an absolute path", async () => {
  const seen = [];
  const show = async (options) => {
    seen.push(options.defaultPath);
    return { canceled: true, filePaths: [] };
  };
  const absolute = path.resolve("start", "here");
  await pickFolder(show, absolute);
  await pickFolder(show, "relative/path");
  await pickFolder(show, 42);
  await pickFolder(show, { toString: () => absolute });
  await pickFolder(show, undefined);
  assert.deepEqual(seen, [absolute, undefined, undefined, undefined, undefined]);
});

test("the workspace comes from the first argument that is not a flag", () => {
  // Unpackaged: [electron, appPath, ...args].
  assert.equal(workspaceArg(["electron.exe", ".", "D:\\work"], true), "D:\\work");
  assert.equal(workspaceArg(["electron.exe", ".", "--remote-debugging-port=9333", "D:\\work"], true), "D:\\work");
  assert.equal(workspaceArg(["electron.exe", "."], true), undefined);
  // Packaged: [app, ...args].
  assert.equal(workspaceArg(["Albireo.exe", "/home/me/project"], false), "/home/me/project");
  assert.equal(workspaceArg(["Albireo.exe", "--no-sandbox"], false), undefined);
  assert.equal(workspaceArg(["Albireo.exe"], false), undefined);
  assert.equal(workspaceArg(["Albireo.exe", "", "x"], false), "x");
});

test("the preload script uses the same message name as the main process", async () => {
  const preload = await readFile(new URL("../dist/preload.cjs", import.meta.url), "utf8");
  assert.ok(preload.includes(`"${PICK_DIRECTORY}"`), "preload.cjs must send the message the shell listens for");
  // A sandboxed preload can't load files: nothing but Electron itself may be required.
  const required = [...preload.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(required, ["electron"]);
});
