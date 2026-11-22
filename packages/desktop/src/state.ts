import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Where the window was, so it comes back there. */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

/**
 * What the app remembers between runs. The port is there because the page keeps its preferences (the
 * session it was on, the side panes) in `localStorage`, which belongs to an origin, and the origin
 * includes the port: a different port each run would forget them every time.
 */
export interface DesktopState {
  port?: number;
  window?: WindowState;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function int(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

/** Keeps what is valid and drops the rest: the file is edited by hand or damaged now and then. */
export function parseState(text: string): DesktopState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const state: DesktopState = {};
  const port = int(record.port, 1024, 65535);
  if (port !== undefined) state.port = port;
  const win = record.window;
  if (typeof win === "object" && win !== null && !Array.isArray(win)) {
    const w = win as Record<string, unknown>;
    const width = int(w.width, 400, 20_000);
    const height = int(w.height, 300, 20_000);
    if (width !== undefined && height !== undefined) {
      const x = int(w.x, -50_000, 50_000);
      const y = int(w.y, -50_000, 50_000);
      state.window = {
        width,
        height,
        maximized: w.maximized === true,
        ...(x !== undefined && y !== undefined ? { x, y } : {}),
      };
    }
  }
  return state;
}

/** The saved state; an empty one when there is none or it can't be read. */
export async function readState(file: string): Promise<DesktopState> {
  try {
    return parseState(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

/** Written to a temporary file first, so a crash can't leave half a file behind. */
export async function writeState(file: string, state: DesktopState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 80;

/**
 * Whether a window at `bounds` can still be reached: enough of it is on one of the screens' work areas.
 * A monitor that was unplugged since would otherwise leave the window out of sight.
 */
export function isReachable(bounds: Rect, areas: readonly Rect[]): boolean {
  return areas.some((area) => {
    const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return width >= MIN_VISIBLE_WIDTH && height >= MIN_VISIBLE_HEIGHT;
  });
}
