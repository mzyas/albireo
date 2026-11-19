import OpenAI from "openai";
import { normalizeHistory } from "../history.js";
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

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatStreamParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

export const OPENAI_COMPLETIONS_API = "openai-completions";
export const OPENAI_DEFAULT_MODEL = "gpt-5";
/** Pass this explicitly to keep the SDK from reading OPENAI_BASE_URL. */
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** Chat Completions rejects tool_call ids longer than 40 characters. */
const MAX_TOOL_ID = 40;
const NO_AUTH_PLACEHOLDER_KEY = "albireo-none";

/** Compatibility toggles for OpenAI Chat Completions endpoints. */
export interface OpenAICompletionsCompat {
  /** Field used for max output tokens. Default: `"max_completion_tokens"`. */
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  /** Send `stream_options: { include_usage: true }`. Default: true. */
  supportsUsageInStreaming?: boolean;
  /** Send the system prompt with role `"developer"` instead of `"system"`. Default: false. */
  supportsDeveloperRole?: boolean;
  /** Send `""` instead of `null` for tool-call-only assistant messages. Default: false. */
  requiresNonNullAssistantContent?: boolean;
}

export interface OpenAIModelOverride {
  maxTokens?: number;
  headers?: ProviderHeaders;
  compat?: OpenAICompletionsCompat;
}

export interface OpenAIOptions {
  /** Provider ID used for registry identity and history normalization. Default: "openai". */
  id?: string;
  apiKey?: string;
  /** When `"none"`, suppresses Authorization and never reads OPENAI_API_KEY. */
  auth?: ProviderAuthMode;
  /** Unset: the SDK falls back to OPENAI_BASE_URL, then its built-in default. */
  baseURL?: string;
  model?: string;
  /** Extra HTTP headers merged onto every request; `null` suppresses a default header. */
  headers?: ProviderHeaders;
  compat?: OpenAICompletionsCompat;
  /** Per-model overrides merged on top of provider-level defaults. */
  modelOverrides?: Record<string, OpenAIModelOverride>;
  /** Custom fetch implementation (mainly for tests). */
  fetch?: typeof globalThis.fetch;
}

/** Chat Completions adapter — also works against OpenAI-compatible endpoints via `baseURL` and `compat`. */
export class OpenAIProvider implements Provider {
  readonly id: string;
  readonly defaultModel: string;
  private client: OpenAI;
  private compat: OpenAICompletionsCompat;
  private modelOverrides: Record<string, OpenAIModelOverride>;

  constructor(opts: OpenAIOptions = {}) {
    this.id = opts.id ?? "openai";
    const defaultHeaders: ProviderHeaders | undefined =
      opts.auth === "none" ? { authorization: null, ...opts.headers } : opts.headers;
    this.client = new OpenAI({
      apiKey: opts.auth === "none" ? NO_AUTH_PLACEHOLDER_KEY : opts.apiKey,
      baseURL: opts.baseURL,
      ...(defaultHeaders ? { defaultHeaders } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.defaultModel = opts.model ?? OPENAI_DEFAULT_MODEL;
    this.compat = opts.compat ? { ...opts.compat } : {};
    this.modelOverrides = opts.modelOverrides ? { ...opts.modelOverrides } : {};
  }

  async runTurn(req: TurnRequest, onEvent: (e: StreamEvent) => void): Promise<TurnResult> {
    const override = this.modelOverrides[req.model];
    const compat: OpenAICompletionsCompat = { ...this.compat, ...override?.compat };
    const params = buildOpenAIParams(req, {
      provider: this.id,
      compat,
      maxTokens: req.maxTokens ?? override?.maxTokens,
    });
    const stream = await this.client.chat.completions.create(params, {
      signal: req.signal,
      ...(override?.headers ? { headers: override.headers } : {}),
    });

    let text = "";
    let finish: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead: number | undefined;
    const calls: { id: string; name: string; args: string }[] = [];

    for await (const chunk of stream) {
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
        cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined;
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta.content) {
        text += delta.content;
        onEvent({ type: "text_delta", text: delta.content });
      }
      // Some OpenAI-compatible servers stream reasoning separately.
      const reasoning = (delta as { reasoning_content?: string }).reasoning_content;
      if (reasoning) onEvent({ type: "reasoning_delta", text: reasoning });
      for (const tc of delta.tool_calls ?? []) {
        let slot = calls[tc.index];
        if (!slot) {
          slot = { id: "", name: "", args: "" };
          calls[tc.index] = slot;
        }
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const content: ContentPart[] = [];
    if (text) content.push({ type: "text", text });
    for (const c of calls.filter(Boolean)) {
      content.push({ type: "tool_call", id: c.id, name: c.name, input: parseArgs(c.args) });
    }

    return {
      message: { role: "assistant", content },
      stopReason: mapFinish(finish),
      usage: { inputTokens, outputTokens, cacheReadTokens: cacheRead },
    };
  }
}

export interface BuildOpenAIParamsOptions {
  provider?: string;
  compat?: OpenAICompletionsCompat;
  maxTokens?: number;
}

/** Pure request builder for `openai-completions`, exported for unit testing. */
export function buildOpenAIParams(
  req: Pick<TurnRequest, "model" | "system" | "messages" | "tools" | "maxTokens">,
  opts: BuildOpenAIParamsOptions = {},
): ChatStreamParams {
  const compat = opts.compat ?? {};
  const maxTokens = opts.maxTokens ?? req.maxTokens;
  const maxTokensField = compat.maxTokensField ?? "max_completion_tokens";
  return {
    model: req.model,
    messages: toOpenAIMessages(req.system, req.messages, req.model, { provider: opts.provider, compat }),
    tools: req.tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
    stream: true,
    ...(compat.supportsUsageInStreaming !== false ? { stream_options: { include_usage: true } } : {}),
    ...(maxTokens !== undefined
      ? maxTokensField === "max_tokens"
        ? { max_tokens: maxTokens }
        : { max_completion_tokens: maxTokens }
      : {}),
  };
}

/** Unparseable arguments become a marker object that fails schema validation downstream. */
function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid_json: raw };
  }
}

function mapFinish(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

export interface ToOpenAIMessagesOptions {
  provider?: string;
  compat?: OpenAICompletionsCompat;
}

export function toOpenAIMessages(
  system: string,
  messages: Message[],
  model = "",
  opts: ToOpenAIMessagesOptions = {},
): ChatMessage[] {
  const compat = opts.compat ?? {};
  const out: ChatMessage[] = [{ role: compat.supportsDeveloperRole ? "developer" : "system", content: system }];
  const history = normalizeHistory(
    messages,
    { provider: opts.provider ?? "openai", model, api: OPENAI_COMPLETIONS_API },
    { maxIdLength: MAX_TOOL_ID },
  );
  for (const m of history) {
    if (m.role === "assistant") {
      const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      const toolCalls = m.content.flatMap((p) =>
        p.type === "tool_call"
          ? [{ id: p.id, type: "function" as const, function: { name: p.name, arguments: JSON.stringify(p.input) } }]
          : [],
      );
      out.push({
        role: "assistant",
        content: text || (compat.requiresNonNullAssistantContent ? "" : null),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      // tool results must directly follow the assistant tool_calls message
      for (const p of m.content) {
        if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.callId, content: p.content });
      }
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}
