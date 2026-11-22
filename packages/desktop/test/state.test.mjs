import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isReachable, parseState, readState, writeState } from "../dist/state.js";

const good = { port: 45123, window: { x: 10, y: 20, width: 1280, height: 800, maximized: true } };

test("a saved state is read back as it was", () => {
  assert.deepEqual(parseState(JSON.stringify(good)), good);
});

test("what is not valid is dropped, the rest kept", () => {
  assert.deepEqual(parseState(JSON.stringify({ ...good, port: 80 })).port, undefined, "a privileged port");
  assert.deepEqual(parseState(JSON.stringify({ ...good, port: 70000 })).port, undefined);
  assert.deepEqual(parseState(JSON.stringify({ ...good, port: "4000" })).port, undefined);
  assert.deepEqual(parseState(JSON.stringify({ ...good, port: 4000.5 })).port, undefined);
  assert.equal(parseState(JSON.stringify({ ...good, port: 80 })).window?.width, 1280);

  // A window that is tiny, huge or not made of numbers is not restored; a missing position is just not placed.
  assert.equal(parseState(JSON.stringify({ window: { ...good.window, width: 10 } })).window, undefined);
  assert.equal(parseState(JSON.stringify({ window: { ...good.window, height: 99999 } })).window, undefined);
  assert.equal(parseState(JSON.stringify({ window: { ...good.window, width: "wide" } })).window, undefined);
  const unplaced = parseState(JSON.stringify({ window: { width: 900, height: 600 } })).window;
  assert.deepEqual(unplaced, { width: 900, height: 600, maximized: false });
  const halfPlaced = parseState(JSON.stringify({ window: { x: 5, width: 900, height: 600 } })).window;
  assert.deepEqual(halfPlaced, { width: 900, height: 600, maximized: false });
});

test("junk is an empty state", () => {
  for (const text of ["", "not json", "null", "[]", "42", '"x"', "{"]) assert.deepEqual(parseState(text), {}, text);
});

test("writing and reading go through a file, atomically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "albireo-desktop-state-"));
  try {
    const file = path.join(dir, "nested", "state.json");
    assert.deepEqual(await readState(file), {}, "missing file");
    await writeState(file, good);
    assert.deepEqual(await readState(file), good);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), good);
    assert.deepEqual(await readdir(path.dirname(file)), ["state.json"], "no temporary file is left behind");

    await writeFile(file, "{ broken");
    assert.deepEqual(await readState(file), {}, "damaged file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a window is reachable only if enough of it is on a screen", () => {
  const screens = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 1920, y: 0, width: 1280, height: 1024 },
  ];
  assert.equal(isReachable({ x: 100, y: 100, width: 1280, height: 800 }, screens), true);
  assert.equal(isReachable({ x: 2000, y: 50, width: 800, height: 600 }, screens), true, "on the second screen");
  assert.equal(isReachable({ x: 1700, y: 100, width: 800, height: 600 }, screens), true, "across both");
  // The second monitor was unplugged: the window is out of sight.
  assert.equal(isReachable({ x: 2000, y: 50, width: 800, height: 600 }, [screens[0]]), false);
  // Only a sliver on screen can't be grabbed.
  assert.equal(isReachable({ x: 1900, y: 100, width: 800, height: 600 }, [screens[0]]), false);
  assert.equal(isReachable({ x: 100, y: 1030, width: 800, height: 600 }, [screens[0]]), false);
  assert.equal(isReachable({ x: 100, y: 100, width: 800, height: 600 }, []), false);
});
