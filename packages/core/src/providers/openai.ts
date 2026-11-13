import OpenAI from "openai";
import type {
  Message,
  Provider,
  StopReason,
  StreamEvent,
  TurnRequest,
  TurnResult,
  ContentPart,
} from "../types.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface OpenAIOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

/** Chat Completions adapter — also works against OpenAI-compatible endpoints via `baseURL`. */
export class OpenAIProvider implements Provider {
  readonly id = "openai";
  readonly defaultModel: string;
  private client: OpenAI;

  constructor(opts: OpenAIOptions = {}) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.defaultModel = opts.model ?? "gpt-5";
  }

  async runTurn(req: TurnRequest, onEvent: (e: StreamEvent) => void): Promise<TurnResult> {
    const stream = await this.client.chat.completions.create(
      {
        model: req.model,
        messages: toOpenAIMessages(req.system, req.messages),
        tools: req.tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        stream: true,
        stream_options: { include_usage: true },
        ...(req.maxTokens ? { max_completion_tokens: req.maxTokens } : {}),
      },
      { signal: req.signal },
    );

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
        const slot = (calls[tc.index] ??= { id: "", name: "", args: "" });
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

export function toOpenAIMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      const toolCalls = m.content.flatMap((p) =>
        p.type === "tool_call"
          ? [{ id: p.id, type: "function" as const, function: { name: p.name, arguments: JSON.stringify(p.input) } }]
          : [],
      );
      out.push({
        role: "assistant",
        content: text || null,
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
