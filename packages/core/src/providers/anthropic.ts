import Anthropic from "@anthropic-ai/sdk";
import { type HistoryTarget, normalizeHistory, replaysNatively } from "../history.js";
import type { ContentPart, Message, Provider, StopReason, StreamEvent, TurnRequest, TurnResult } from "../types.js";

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

/** Wire API tag stored on native payloads so they only replay against the same API. */
export const ANTHROPIC_MESSAGES_API = "anthropic-messages";
const MAX_TOOL_ID = 64;

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  /** Server-side refusal fallback (beta). On by default; set false to disable. */
  fallbacks?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly defaultModel: string;
  private client: Anthropic;
  private fallbacks: boolean;
  private effort: NonNullable<AnthropicOptions["effort"]>;

  constructor(opts: AnthropicOptions = {}) {
    // With no explicit key the SDK resolves ANTHROPIC_API_KEY / auth token / `ant auth login` profile.
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : undefined);
    this.defaultModel = opts.model ?? "claude-opus-5-5";
    this.fallbacks = opts.fallbacks ?? true;
    this.effort = opts.effort ?? "high";
  }

  async runTurn(req: TurnRequest, onEvent: (e: StreamEvent) => void): Promise<TurnResult> {
    const tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
      eager_input_streaming: true,
    }));

    const betas = ["server-side-fallback-2026-07-01"];
    const params = {
      model: req.model,
      max_tokens: req.maxTokens ?? 64000,
      system: req.system,
      messages: toAnthropicMessages(req.messages, req.model),
      tools,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: this.effort },
      ...(this.fallbacks ? { betas, fallbacks: "default" } : {}),
    };

    // Beta-only fields (fallbacks, thinking display) are cast: the helper types lag the API.
    const stream = this.client.beta.messages.stream(
      params as unknown as Parameters<Anthropic["beta"]["messages"]["stream"]>[0],
      { signal: req.signal },
    );

    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "text_delta") onEvent({ type: "text_delta", text: event.delta.text });
      else if (event.delta.type === "thinking_delta") onEvent({ type: "reasoning_delta", text: event.delta.thinking });
    }
    const final = await stream.finalMessage();

    const content: ContentPart[] = [];
    for (const block of final.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "tool_use")
        content.push({ type: "tool_call", id: block.id, name: block.name, input: block.input });
    }

    return {
      message: {
        role: "assistant",
        content,
        // Thinking blocks must be replayed unchanged on the same model.
        native: { provider: this.id, model: req.model, api: ANTHROPIC_MESSAGES_API, payload: final.content },
      },
      stopReason: mapStop(final.stop_reason),
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? undefined,
      },
    };
  }
}

function mapStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

export function toAnthropicMessages(messages: Message[], model: string): BetaMessageParam[] {
  const target: HistoryTarget = { provider: "anthropic", model, api: ANTHROPIC_MESSAGES_API };
  return normalizeHistory(messages, target, { maxIdLength: MAX_TOOL_ID }).map((m): BetaMessageParam => {
    if (m.native && replaysNatively(m, target)) {
      return { role: "assistant", content: m.native.payload as BetaContentBlockParam[] };
    }
    const content: BetaContentBlockParam[] = [];
    for (const p of m.content) {
      if (p.type === "text") {
        if (p.text) content.push({ type: "text", text: p.text }); // empty text blocks are rejected
      } else if (p.type === "tool_call") {
        content.push({ type: "tool_use", id: p.id, name: p.name, input: p.input });
      } else {
        content.push({ type: "tool_result", tool_use_id: p.callId, content: p.content, is_error: p.isError });
      }
    }
    return { role: m.role, content };
  });
}
