import type { Provider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_MESSAGES_API,
  type AnthropicCompat,
  type AnthropicModelOverride,
  type AnthropicOptions,
  AnthropicProvider,
  type BuildAnthropicParamsOptions,
  buildAnthropicParams,
  toAnthropicMessages,
} from "./anthropic.js";
export {
  type BuildOpenAIParamsOptions,
  buildOpenAIParams,
  OPENAI_COMPLETIONS_API,
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  type OpenAICompletionsCompat,
  type OpenAIModelOverride,
  type OpenAIOptions,
  OpenAIProvider,
  type ToOpenAIMessagesOptions,
  toOpenAIMessages,
} from "./openai.js";
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

  unregister(id: string): boolean {
    this.cache.delete(id);
    return this.factories.delete(id);
  }

  has(id: string): boolean {
    return this.factories.has(id);
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

/**
 * Reads keys, endpoints and models from the environment. The CLI does not use this (its registry
 * comes from the encrypted vault in @albireo/vault); test-live does.
 */
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
