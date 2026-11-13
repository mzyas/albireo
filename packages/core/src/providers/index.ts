import type { Provider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export { AnthropicProvider, toAnthropicMessages, ANTHROPIC_MESSAGES_API } from "./anthropic.js";
export { OpenAIProvider, toOpenAIMessages, OPENAI_CHAT_API } from "./openai.js";
export { ScriptedProvider, type ScriptStep } from "./scripted.js";

/** Lazily constructs providers so a missing key for one vendor doesn't block the other. */
export class ProviderRegistry {
  private factories = new Map<string, () => Provider>();
  private cache = new Map<string, Provider>();

  register(id: string, factory: () => Provider): this {
    this.factories.set(id, factory);
    this.cache.delete(id);
    return this;
  }

  ids(): string[] {
    return [...this.factories.keys()];
  }

  get(id: string): Provider {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`Unknown provider "${id}". Available: ${this.ids().join(", ")}`);
    const provider = factory();
    this.cache.set(id, provider);
    return provider;
  }
}

export function defaultRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  return new ProviderRegistry()
    .register("anthropic", () => new AnthropicProvider({ model: env.ALBIREO_ANTHROPIC_MODEL }))
    .register("openai", () => {
      if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
      return new OpenAIProvider({
        apiKey: env.OPENAI_API_KEY,
        baseURL: env.OPENAI_BASE_URL,
        model: env.ALBIREO_OPENAI_MODEL,
      });
    });
}
