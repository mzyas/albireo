import Anthropic from "@anthropic-ai/sdk";
import { type HistoryTarget, normalizeHistory, replaysNatively } from "../history.js";
import type {
  ContentPart,
  Message,
  Provider,
  ProviderAuthMode,
  ProviderHeaders,
  StopReason,
  StreamEvent,
  TurnRequest,
  TurnResult,
} from "../types.js";

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

/** Wire API tag stored on native payloads so they only replay against the same API. */
export const ANTHROPIC_MESSAGES_API = "anthropic-messages";
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
/** Pass this explicitly to keep the SDK from reading ANTHROPIC_BASE_URL. */
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const MAX_TOOL_ID = 64;
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const NO_AUTH_PLACEHOLDER_KEY = "albireo-none";

/** Compatibility toggles for Anthropic-messages endpoints. */
export interface AnthropicCompat {
  /** Include `eager_input_streaming: true` on tool specs. Default: true. */
  supportsEagerToolInputStreaming?: boolean;
  /** Send the server-side refusal fallback beta header + `fallbacks: "default"`. Default: true. */
  supportsFallbacks?: boolean;
  /** Adaptive thinking + output_config.effort ("adaptive") or omitted ("none"). Default: "adaptive". */
  thinkingMode?: "adaptive" | "none";
}

export interface AnthropicModelOverride {
  maxTokens?: number;
  headers?: ProviderHeaders;
  compat?: AnthropicCompat;
}

export interface AnthropicOptions {
  /** Provider ID used for registry identity and native payload matching. Default: "anthropic". */
  id?: string;
  apiKey?: string;
  /** Bearer token sent as `Authorization: Bearer ...` instead of `x-api-key`. */
  authToken?: string;
  /** When `"none"`, suppresses SDK auth headers and never reads environment variables. */
  auth?: ProviderAuthMode;
  /** Unset: the SDK falls back to ANTHROPIC_BASE_URL, then its built-in default. */
  baseURL?: string;
  model?: string;
  /** Extra HTTP headers merged onto every request; `null` suppresses a default header. */
  headers?: ProviderHeaders;
  compat?: AnthropicCompat;
  /** Per-model overrides merged on top of provider-level defaults. */
  modelOverrides?: Record<string, AnthropicModelOverride>;
  /** Server-side refusal fallback (beta). Shorthand when `compat.supportsFallbacks` is unset. */
  fallbacks?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Custom fetch implementation (mainly for tests). */
  fetch?: typeof globalThis.fetch;
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly defaultModel: string;
  private client: Anthropic;
  private compat: AnthropicCompat;
  private modelOverrides: Record<string, AnthropicModelOverride>;
  private fallbacks: boolean;
  private effort: NonNullable<AnthropicOptions["effort"]>;

  constructor(opts: AnthropicOptions = {}) {
    this.id = opts.id ?? "anthropic";
    const defaultHeaders: ProviderHeaders | undefined =
      opts.auth === "none" ? { authorization: null, "x-api-key": null, ...opts.headers } : opts.headers;
    const authOpts =
      opts.auth === "none"
        ? { apiKey: NO_AUTH_PLACEHOLDER_KEY }
        : opts.authToken
          ? { authToken: opts.authToken }
          : opts.apiKey
            ? { apiKey: opts.apiKey }
            : {};
    // With no explicit key the SDK resolves ANTHROPIC_API_KEY / auth token / `ant auth login` profile.
    this.client = new Anthropic({
      ...authOpts,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(defaultHeaders ? { defaultHeaders } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.defaultModel = opts.model ?? ANTHROPIC_DEFAULT_MODEL;
    this.compat = opts.compat ? { ...opts.compat } : {};
    this.modelOverrides = opts.modelOverrides ? { ...opts.modelOverrides } : {};
    this.fallbacks = opts.fallbacks ?? true;
    this.effort = opts.effort ?? "high";
  }

  async runTurn(req: TurnRequest, onEvent: (e: StreamEvent) => void): Promise<TurnResult> {
    const override = this.modelOverrides[req.model];
    const compat: AnthropicCompat = { ...this.compat, ...override?.compat };
    const params = buildAnthropicParams(req, {
      provider: this.id,
      compat,
      fallbacks: this.fallbacks,
      effort: this.effort,
      maxTokens: req.maxTokens ?? override?.maxTokens,
    });

    // Beta-only fields (fallbacks, thinking display) are cast: the helper types lag the API.
    const stream = this.client.beta.messages.stream(
      params as unknown as Parameters<Anthropic["beta"]["messages"]["stream"]>[0],
      {
        signal: req.signal,
        ...(override?.headers ? { headers: override.headers } : {}),
      },
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
        // Thinking blocks must be replayed unchanged on the same provider, model, and API.
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

export interface BuildAnthropicParamsOptions {
  provider?: string;
  compat?: AnthropicCompat;
  fallbacks?: boolean;
  effort?: NonNullable<AnthropicOptions["effort"]>;
  maxTokens?: number;
}

/** Pure request builder for `anthropic-messages`, exported for unit testing. */
export function buildAnthropicParams(
  req: Pick<TurnRequest, "model" | "system" | "messages" | "tools" | "maxTokens">,
  opts: BuildAnthropicParamsOptions = {},
): Record<string, unknown> {
  const compat = opts.compat ?? {};
  const supportsEager = compat.supportsEagerToolInputStreaming ?? true;
  const supportsFallbacks = compat.supportsFallbacks ?? opts.fallbacks ?? true;
  const thinkingMode = compat.thinkingMode ?? "adaptive";
  const effort = opts.effort ?? "high";

  const tools = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    ...(supportsEager ? { eager_input_streaming: true } : {}),
  }));

  return {
    model: req.model,
    max_tokens: opts.maxTokens ?? req.maxTokens ?? 64000,
    system: req.system,
    messages: toAnthropicMessages(req.messages, req.model, { provider: opts.provider }),
    tools,
    ...(thinkingMode === "adaptive"
      ? { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort } }
      : {}),
    ...(supportsFallbacks ? { betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: "default" } : {}),
  };
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

export function toAnthropicMessages(
  messages: Message[],
  model: string,
  opts: { provider?: string } = {},
): BetaMessageParam[] {
  const target: HistoryTarget = { provider: opts.provider ?? "anthropic", model, api: ANTHROPIC_MESSAGES_API };
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
