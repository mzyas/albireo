/**
 * Provider-neutral conversation model. Every provider adapter converts to and
 * from these types, so a session can switch providers between turns.
 */

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; content: string; isError?: boolean };

export interface Message {
  role: "user" | "assistant";
  content: ContentPart[];
  /**
   * Provider-native replay payload (e.g. Anthropic content blocks including
   * thinking blocks, which must be passed back unchanged). Only valid for the
   * same provider AND model that produced it; adapters ignore it otherwise and
   * rebuild from `content`.
   */
  native?: { provider: string; model: string; payload: unknown };
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string };

export interface TurnRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface TurnResult {
  message: Message;
  stopReason: StopReason;
  usage: Usage;
}

/** One model turn: stream deltas through `onEvent`, resolve with the full assistant message. */
export interface Provider {
  readonly id: string;
  readonly defaultModel: string;
  runTurn(req: TurnRequest, onEvent: (e: StreamEvent) => void): Promise<TurnResult>;
}
