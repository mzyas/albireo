import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseActive,
  formatAgo,
  groupByWorkspace,
  sessionTitle,
  waitingCount,
  workspaceKey,
} from "../src/lib/sessions.ts";
import type { SessionSummary, SessionsResponse } from "../src/protocol.ts";

let n = 0;
function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  n++;
  return {
    id: `s${n}`,
    title: "",
    cwd: "/work/app",
    provider: "p",
    model: "m",
    createdAt: 1000,
    updatedAt: 1000,
    messageCount: 0,
    live: false,
    status: "idle",
    pending: 0,
    ...over,
  };
}

function list(sessions: SessionSummary[], primary: string | null = null): SessionsResponse {
  return { sessions, workspaces: [], primary, canCreate: true, cwd: "/work/app" };
}

test("sessionTitle names a session that has no message yet", () => {
  assert.equal(sessionTitle({ title: "fix the build" }), "fix the build");
  assert.equal(sessionTitle({ title: "" }), "New session");
});

test("formatAgo uses the fewest words and falls back to a date", () => {
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  assert.equal(formatAgo(now - 5_000, now), "just now");
  assert.equal(formatAgo(now + 5_000, now), "just now", "a clock a little ahead is not an error");
  assert.equal(formatAgo(now - 5 * 60_000, now), "5 min ago");
  assert.equal(formatAgo(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(formatAgo(now - 2 * 86_400_000, now), "2 d ago");
  assert.doesNotMatch(formatAgo(now - 30 * 86_400_000, now), /ago/);
});

test("workspaceKey treats one folder written two ways as one, and keeps Unix case", () => {
  assert.equal(workspaceKey("C:\\Work\\App\\"), workspaceKey("c:/work/app"));
  assert.notEqual(workspaceKey("/Work/app"), workspaceKey("/work/app"));
  assert.equal(workspaceKey("/work/app/"), "/work/app");
});

test("groupByWorkspace puts the workspace used last first and each group's newest session first", () => {
  const a1 = summary({ cwd: "/work/api", updatedAt: 100 });
  const a2 = summary({ cwd: "/work/api", updatedAt: 300 });
  const w1 = summary({ cwd: "/work/web", updatedAt: 200 });
  const groups = groupByWorkspace([a1, w1, a2]);
  assert.deepEqual(
    groups.map((g) => [g.name, g.sessions.map((s) => s.id)]),
    [
      ["api", [a2.id, a1.id]],
      ["web", [w1.id]],
    ],
  );
});

test("groupByWorkspace merges spellings of one folder and tells same-named folders apart", () => {
  const merged = groupByWorkspace([summary({ cwd: "C:\\Work\\App" }), summary({ cwd: "c:/work/app/" })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.sessions.length, 2);

  const apart = groupByWorkspace([
    summary({ cwd: "/home/me/app" }),
    summary({ cwd: "/srv/app" }),
    summary({ cwd: "/srv/other" }),
  ]);
  assert.deepEqual(apart.map((g) => g.name).sort(), ["me/app", "other", "srv/app"]);
  assert.deepEqual(groupByWorkspace([]), []);
});

test("chooseActive keeps what is shown, then the last viewed, then the default, then the newest", () => {
  const a = summary({ updatedAt: 10 });
  const b = summary({ updatedAt: 20 });
  const c = summary({ updatedAt: 5 });
  const l = list([b, a, c], c.id);
  assert.equal(chooseActive(l, a.id, b.id), a.id, "the one in view stays");
  assert.equal(chooseActive(l, "gone", b.id), b.id, "else the one looked at last");
  assert.equal(chooseActive(l, null, "gone"), c.id, "else the server's default");
  assert.equal(chooseActive(list([b, a], null), null, null), b.id, "else the first, which is the newest");
  assert.equal(chooseActive(list([], null), "x", "y"), null);
  assert.equal(chooseActive(list([a], "stale"), null, null), a.id, "a default that is not listed is ignored");
});

test("waitingCount counts sessions with a tool call waiting", () => {
  assert.equal(waitingCount([summary(), summary({ pending: 2 }), summary({ pending: 1 })]), 2);
  assert.equal(waitingCount([]), 0);
});
