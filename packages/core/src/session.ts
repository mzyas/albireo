import { EventEmitter } from "node:events";
import { z } from "zod";
import { toSpec, type AnyTool, type Risk } from "./tool.js";
import type { ProviderRegistry } from "./providers/index.js";
import type { ContentPart, Message, Provider, StopReason, ToolSpec, Usage } from "./types.js";

/** Events are what every front end (GUI panel, CLI) consumes. */
export type KernelEvent =
  | { type: "user"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "assistant_end"; text: string; stopReason: StopReason; usage: Usage; provider: string; model: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; risk: Risk | "unknown" }
  | { type: "approval_request"; id: string; name: string; input: unknown; risk: Risk }
  | { type: "approval_resolved"; id: string; allow: boolean }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | { type: "provider_changed"; provider: string; model: string }
  | { type: "status"; state: "idle" | "running" }
  | { type: "notice"; text: string }
  | { type: "error"; message: string };

export type LoggedEvent = KernelEvent & { seq: number };

/** Streaming deltas are transient; everything else is kept so late joiners can replay. */
const TRANSIENT = new Set<KernelEvent["type"]>(["text_delta", "reasoning_delta"]);

export interface SessionOptions {
  providers: ProviderRegistry;
  provider: string;
  model?: string;
  tools: AnyTool[];
  cwd: string;
  system?: string;
  /** Risk levels executed without asking. Default: ["read"]. */
  autoApprove?: Risk[];
  maxSteps?: number;
}

export interface Snapshot {
  log: LoggedEvent[];
  live: { text: string; reasoning: string } | null;
  status: "idle" | "running";
  provider: string;
  model: string;
  providers: string[];
  pending: Extract<KernelEvent, { type: "approval_request" }>[];
}

const MAX_LOG = 5000;
const MAX_TOOL_OUTPUT = 30_000;

export class Session {
  readonly history: Message[] = [];
  private log: LoggedEvent[] = [];
  private bus = new EventEmitter();
  private seq = 0;
  private running = false;
  private abortCtl?: AbortController;
  private live: { text: string; reasoning: string } | null = null;
  private pending = new Map<string, (allow: boolean) => void>();
  private pendingEvents = new Map<string, Extract<KernelEvent, { type: "approval_request" }>>();
  private toolMap: Map<string, AnyTool>;
  private toolSpecs: ToolSpec[];
  private autoApprove: Set<Risk>;
  private maxSteps: number;
  private system: string;
  private registry: ProviderRegistry;
  private provider: Provider;
  private _model: string;
  readonly cwd: string;

  constructor(opts: SessionOptions) {
    this.registry = opts.providers;
    this.provider = this.registry.get(opts.provider);
    this._model = opts.model ?? this.provider.defaultModel;
    this.toolMap = new Map(opts.tools.map((t) => [t.name, t]));
    this.toolSpecs = opts.tools.map(toSpec);
    this.autoApprove = new Set(opts.autoApprove ?? ["read"]);
    this.maxSteps = opts.maxSteps ?? 30;
    this.cwd = opts.cwd;
    this.system =
      opts.system ??
      `You are Albireo, a careful coding agent working in ${opts.cwd} (platform: ${process.platform}). ` +
        `Use the provided tools to inspect and change files. Be concise.`;
  }

  get providerId(): string {
    return this.provider.id;
  }
  get model(): string {
    return this._model;
  }
  get status(): "idle" | "running" {
    return this.running ? "running" : "idle";
  }

  on(listener: (e: LoggedEvent) => void): () => void {
    this.bus.on("event", listener);
    return () => this.bus.off("event", listener);
  }

  snapshot(): Snapshot {
    return {
      log: [...this.log],
      live: this.live ? { ...this.live } : null,
      status: this.status,
      provider: this.providerId,
      model: this.model,
      providers: this.registry.ids(),
      pending: [...this.pendingEvents.values()],
    };
  }

  /** Switch vendor/model between turns; the neutral history carries over. */
  switchProvider(id: string, model?: string): void {
    if (this.running) throw new Error("Cannot switch provider while a turn is running");
    this.provider = this.registry.get(id);
    this._model = model ?? this.provider.defaultModel;
    this.emit({ type: "provider_changed", provider: this.providerId, model: this._model });
  }

  approve(id: string, allow: boolean): void {
    this.pending.get(id)?.(allow);
  }

  abort(): void {
    this.abortCtl?.abort();
  }

  async send(text: string): Promise<void> {
    if (this.running) {
      this.emit({ type: "error", message: "A turn is already running" });
      return;
    }
    this.running = true;
    this.abortCtl = new AbortController();
    const signal = this.abortCtl.signal;
    this.emit({ type: "status", state: "running" });
    this.history.push({ role: "user", content: [{ type: "text", text }] });
    this.emit({ type: "user", text });

    try {
      for (let step = 0; step < this.maxSteps; step++) {
        this.live = { text: "", reasoning: "" };
        const provider = this.provider;
        const model = this._model;
        let res;
        try {
          res = await provider.runTurn(
            { model, system: this.system, messages: [...this.history], tools: this.toolSpecs, signal },
            (ev) => {
              if (this.live) this.live[ev.type === "text_delta" ? "text" : "reasoning"] += ev.text;
              this.emit(ev);
            },
          );
        } finally {
          this.live = null;
        }

        const text = res.message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
        this.emit({
          type: "assistant_end",
          text,
          stopReason: res.stopReason,
          usage: res.usage,
          provider: provider.id,
          model,
        });

        if (res.stopReason === "refusal") {
          // Drop the turn: it may hold a half-formed tool call that can never be answered.
          this.emit({ type: "notice", text: "The model refused this request." });
          break;
        }
        this.history.push(res.message);

        const calls = res.message.content.filter(
          (p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call",
        );
        if (calls.length === 0) {
          if (res.stopReason === "max_tokens") this.emit({ type: "notice", text: "Output hit the token limit." });
          break;
        }

        const results: ContentPart[] = [];
        for (const call of calls) {
          if (res.stopReason === "max_tokens") {
            // A tool input cut off at the limit may still parse; never run it.
            results.push(this.fail(call.id, call.name, "Output was truncated at the token limit; retry with a smaller call."));
          } else if (signal.aborted) {
            results.push(this.fail(call.id, call.name, "Aborted by user."));
          } else {
            results.push(await this.runCall(call, signal));
          }
        }
        this.history.push({ role: "user", content: results });
        if (signal.aborted) {
          this.emit({ type: "notice", text: "Aborted." });
          break;
        }
        if (step === this.maxSteps - 1) this.emit({ type: "notice", text: `Stopped after ${this.maxSteps} steps.` });
      }
    } catch (err) {
      if (signal.aborted) this.emit({ type: "notice", text: "Aborted." });
      else this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      for (const resolve of [...this.pending.values()]) resolve(false);
      this.running = false;
      this.abortCtl = undefined;
      this.emit({ type: "status", state: "idle" });
    }
  }

  // ---- internals -----------------------------------------------------------

  private fail(id: string, name: string, message: string): ContentPart {
    this.emit({ type: "tool_result", id, name, content: message, isError: true });
    return { type: "tool_result", callId: id, content: message, isError: true };
  }

  private async runCall(
    call: Extract<ContentPart, { type: "tool_call" }>,
    signal: AbortSignal,
  ): Promise<ContentPart> {
    const tool = this.toolMap.get(call.name);
    this.emit({ type: "tool_call", id: call.id, name: call.name, input: call.input, risk: tool?.risk ?? "unknown" });
    if (!tool) return this.fail(call.id, call.name, `Unknown tool: ${call.name}`);

    // Models can emit malformed input; validate before anything runs.
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) return this.fail(call.id, call.name, `Invalid input: ${z.prettifyError(parsed.error)}`);

    if (!this.autoApprove.has(tool.risk)) {
      const allow = await this.waitForApproval(call.id, call.name, call.input, tool.risk, signal);
      if (!allow) return this.fail(call.id, call.name, "The user denied this tool call.");
    }

    try {
      let out = await tool.run(parsed.data, { cwd: this.cwd, signal });
      if (out.length > MAX_TOOL_OUTPUT) out = out.slice(0, MAX_TOOL_OUTPUT) + "\n…[truncated]";
      this.emit({ type: "tool_result", id: call.id, name: call.name, content: out, isError: false });
      return { type: "tool_result", callId: call.id, content: out };
    } catch (err) {
      return this.fail(call.id, call.name, err instanceof Error ? err.message : String(err));
    }
  }

  private waitForApproval(id: string, name: string, input: unknown, risk: Risk, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const done = (allow: boolean) => {
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        this.pendingEvents.delete(id);
        this.emit({ type: "approval_resolved", id, allow });
        resolve(allow);
      };
      const onAbort = () => done(false);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, done);
      const ev = { type: "approval_request", id, name, input, risk } as const;
      this.pendingEvents.set(id, ev);
      this.emit(ev);
    });
  }

  private emit(e: KernelEvent): void {
    const logged = { ...e, seq: ++this.seq } as LoggedEvent;
    if (!TRANSIENT.has(e.type)) {
      this.log.push(logged);
      if (this.log.length > MAX_LOG) this.log.shift();
    }
    this.bus.emit("event", logged);
  }
}
