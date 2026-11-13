// Live integration check for the provider adapters. Makes a handful of tiny real API calls.
// Not part of `pnpm test`. Run:  pnpm build && pnpm --filter @albireo/core test:live
// Reads ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) and OPENAI_API_KEY from the environment.
// Optional: ALBIREO_ANTHROPIC_MODEL, ALBIREO_OPENAI_MODEL, OPENAI_BASE_URL.
// Output contains no secrets.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Session, builtinTools, defaultRegistry } from "../dist/index.js";

const env = process.env;
const have = {
  anthropic: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
  openai: Boolean(env.OPENAI_API_KEY),
};
const registry = defaultRegistry();
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    record(name, true, `${detail ?? ""} (${Date.now() - t0}ms)`.trim());
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record(name, false, msg.split("\n")[0].slice(0, 400));
    return false;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Send one user message, auto-approve tool calls, return what happened. */
async function ask(session, text) {
  const events = [];
  const off = session.on((e) => {
    events.push(e);
    if (e.type === "approval_request") session.approve(e.id, true);
  });
  const timer = setTimeout(() => session.abort(), 120_000);
  try {
    await session.send(text);
  } finally {
    clearTimeout(timer);
    off();
  }
  const error = events.find((e) => e.type === "error");
  if (error) throw new Error(`session error: ${error.message}`);
  const ends = events.filter((e) => e.type === "assistant_end");
  const last = ends.at(-1);
  return {
    events,
    ends,
    last,
    text: last?.text ?? "",
    calls: events.filter((e) => e.type === "tool_call"),
    results: events.filter((e) => e.type === "tool_result"),
    approvals: events.filter((e) => e.type === "approval_request"),
  };
}

function makeSession(provider, cwd) {
  return new Session({ providers: registry, provider, tools: builtinTools, cwd, autoApprove: ["read"] });
}

async function probeModels() {
  if (have.anthropic) {
    await step("anthropic: default model is available", async () => {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const id = registry.get("anthropic").defaultModel;
      const m = await new Anthropic().models.retrieve(id);
      return `${m.id} (${m.display_name})`;
    });
  }
  if (have.openai) {
    const id = registry.get("openai").defaultModel;
    const ok = await step("openai: default model is available", async () => {
      const { default: OpenAI } = await import("openai");
      const m = await new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL }).models.retrieve(id);
      return m.id;
    });
    if (!ok) {
      try {
        const { default: OpenAI } = await import("openai");
        const ids = [];
        for await (const m of new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL }).models.list()) ids.push(m.id);
        const chatty = ids.filter((x) => /^(gpt|o\d|chatgpt)/.test(x)).sort();
        console.log(`      "${id}" not usable. Chat-like models on this key (set ALBIREO_OPENAI_MODEL):\n      ${chatty.slice(0, 40).join(", ")}`);
      } catch (err) {
        console.log(`      could not list models: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      }
    }
  }
}

async function singleProvider(provider) {
  const cwd = await mkdtemp(path.join(tmpdir(), "albireo-live-"));
  await writeFile(path.join(cwd, "hello-albireo.txt"), "x");
  const session = makeSession(provider, cwd);
  console.log(`\n== ${provider} · ${session.model}`);

  await step(`${provider}: plain text turn`, async () => {
    const r = await ask(session, "Reply with exactly one word: pong. No punctuation.");
    assert(/pong/i.test(r.text), `unexpected reply: ${JSON.stringify(r.text.slice(0, 80))}`);
    assert(r.last.stopReason === "end_turn", `stopReason was ${r.last.stopReason}`);
    assert(r.last.usage.outputTokens > 0, "no usage reported");
    return `in=${r.last.usage.inputTokens} out=${r.last.usage.outputTokens} cacheRead=${r.last.usage.cacheReadTokens ?? 0}`;
  });

  await step(`${provider}: read-only tool call round trip`, async () => {
    const r = await ask(session, "Use the list_dir tool on the current directory (path \".\"), then tell me the file name you saw.");
    assert(r.calls.some((c) => c.name === "list_dir"), "model did not call list_dir");
    assert(r.results.length > 0 && r.results.every((x) => !x.isError), "tool result was an error");
    assert(/hello-albireo/.test(r.text), `final answer missed the file name: ${JSON.stringify(r.text.slice(0, 120))}`);
    return `${r.ends.length} model turns, ${r.calls.length} tool call(s)`;
  });

  await step(`${provider}: write tool needs approval and runs`, async () => {
    const r = await ask(session, "Create a file named note.txt containing exactly: hi from albireo. Use the write_file tool.");
    assert(r.approvals.length >= 1, "no approval was requested for a write tool");
    const body = await readFile(path.join(cwd, "note.txt"), "utf8").catch(() => null);
    assert(body !== null, "note.txt was not created");
    assert(body.includes("hi from albireo"), `unexpected file contents: ${JSON.stringify(body.slice(0, 60))}`);
    return `approvals=${r.approvals.length}`;
  });

  await step(`${provider}: later turn recalls earlier tool history`, async () => {
    const r = await ask(session, "What was the name of the file you listed earlier with list_dir? Answer with the name only.");
    assert(/hello-albireo/.test(r.text), `reply: ${JSON.stringify(r.text.slice(0, 80))}`);
    return "history (incl. native blocks) replayed";
  });

  await rm(cwd, { recursive: true, force: true });
}

async function crossProvider(from, to) {
  const cwd = await mkdtemp(path.join(tmpdir(), "albireo-live-"));
  await writeFile(path.join(cwd, "hello-albireo.txt"), "x");
  const session = makeSession(from, cwd);
  console.log(`\n== switch ${from} -> ${to} -> ${from}`);

  await step(`${from}->${to}: tool turn on ${from}`, async () => {
    const r = await ask(session, "Use the list_dir tool on \".\" and tell me the file name.");
    assert(r.calls.length > 0 && /hello-albireo/.test(r.text), `reply: ${JSON.stringify(r.text.slice(0, 80))}`);
  });
  session.switchProvider(to);
  await step(`${from}->${to}: ${to} continues the transcript`, async () => {
    const r = await ask(session, "Which file did the earlier list_dir call show? Name only.");
    assert(/hello-albireo/.test(r.text), `reply: ${JSON.stringify(r.text.slice(0, 80))}`);
    return `now on ${session.providerId} · ${session.model}`;
  });
  session.switchProvider(from);
  await step(`${to}->${from}: back on ${from} after a foreign turn`, async () => {
    const r = await ask(session, "Use the list_dir tool on \".\" once more and tell me how many entries there are.");
    assert(r.calls.length > 0, "model did not call the tool");
    return `now on ${session.providerId} · ${session.model}`;
  });
  await rm(cwd, { recursive: true, force: true });
}

console.log(`credentials: anthropic=${have.anthropic ? "present" : "MISSING"}  openai=${have.openai ? "present" : "MISSING"}`);
if (!have.anthropic && !have.openai) {
  console.log("Nothing to test. Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY in this shell and rerun.");
  process.exit(0);
}

await probeModels();
for (const p of ["anthropic", "openai"]) {
  if (have[p]) await singleProvider(p);
  else console.log(`\nSKIP  ${p}: no credentials`);
}
if (have.anthropic && have.openai) {
  await crossProvider("anthropic", "openai");
  await crossProvider("openai", "anthropic");
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
