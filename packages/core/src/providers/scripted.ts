import type { Provider, StreamEvent, TurnRequest, TurnResult, ContentPart } from "../types.js";

export interface ScriptStep {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
}

/** Deterministic provider for tests and offline demos. Replays `steps` in order. */
export class ScriptedProvider implements Provider {
  readonly id: string;
  readonly defaultModel = "scripted-1";
  private n = 0;
  readonly requests: TurnRequest[] = [];

  constructor(
    private steps: ScriptStep[],
    id = "scripted",
  ) {
    this.id = id;
  }

  async runTurn(req: TurnRequest, onEvent: (e: StreamEvent) => void): Promise<TurnResult> {
    this.requests.push(req);
    const step = this.steps.shift() ?? { text: "(script exhausted)" };
    const content: ContentPart[] = [];
    if (step.text) {
      onEvent({ type: "text_delta", text: step.text });
      content.push({ type: "text", text: step.text });
    }
    for (const c of step.toolCalls ?? []) {
      content.push({ type: "tool_call", id: `call_${++this.n}`, name: c.name, input: c.input });
    }
    return {
      message: { role: "assistant", content },
      stopReason: step.toolCalls?.length ? "tool_use" : "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
