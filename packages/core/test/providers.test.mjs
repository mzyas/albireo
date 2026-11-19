import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_MESSAGES_API,
  AnthropicProvider,
  buildAnthropicParams,
  buildOpenAIParams,
  OPENAI_COMPLETIONS_API,
  OpenAIProvider,
  ProviderRegistry,
  toAnthropicMessages,
  toOpenAIMessages,
} from "../dist/index.js";

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const asst = (...content) => ({ role: "assistant", content });
const toolSpec = {
  name: "list_dir",
  description: "List directory",
  inputSchema: { type: "object", properties: {} },
};

test("toAnthropicMessages isolates native replay by custom provider id", () => {
  const payload = [{ type: "text", text: "NATIVE" }];
  const history = [
    user("hi"),
    {
      role: "assistant",
      content: [{ type: "text", text: "neutral" }],
      native: { provider: "anthropic-proxy", model: "claude-x", api: ANTHROPIC_MESSAGES_API, payload },
    },
    user("next"),
  ];
  assert.deepEqual(toAnthropicMessages(history, "claude-x", { provider: "anthropic-proxy" })[1].content, payload);
  assert.equal(toAnthropicMessages(history, "claude-x")[1].content[0].text, "neutral");
  assert.equal(toAnthropicMessages(history, "claude-x", { provider: "other-proxy" })[1].content[0].text, "neutral");
});

test("buildAnthropicParams respects compat toggles", () => {
  const req = { model: "claude-x", system: "sys", messages: [user("hi")], tools: [toolSpec] };

  const defaults = buildAnthropicParams(req);
  assert.equal(defaults.tools[0].eager_input_streaming, true);
  assert.equal(defaults.fallbacks, "default");
  assert.deepEqual(defaults.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(defaults.output_config, { effort: "high" });

  const stripped = buildAnthropicParams(req, {
    provider: "custom-ant",
    compat: { supportsEagerToolInputStreaming: false, supportsFallbacks: false, thinkingMode: "none" },
    maxTokens: 4096,
  });
  assert.equal("eager_input_streaming" in stripped.tools[0], false);
  assert.equal("fallbacks" in stripped, false);
  assert.equal("betas" in stripped, false);
  assert.equal("thinking" in stripped, false);
  assert.equal("output_config" in stripped, false);
  assert.equal(stripped.max_tokens, 4096);
});

test("OPENAI_COMPLETIONS_API and buildOpenAIParams / toOpenAIMessages honour compat flags", () => {
  assert.equal(OPENAI_COMPLETIONS_API, "openai-completions");
  const history = [
    user("go"),
    asst({ type: "tool_call", id: "c1", name: "list_dir", input: {} }),
    { role: "user", content: [{ type: "tool_result", callId: "c1", content: "ok" }] },
  ];

  const std = buildOpenAIParams(
    { model: "gpt-x", system: "sys", messages: history, tools: [toolSpec], maxTokens: 1024 },
    { provider: "openai" },
  );
  assert.equal(std.messages[0].role, "system");
  assert.equal(std.messages[2].content, null);
  assert.deepEqual(std.stream_options, { include_usage: true });
  assert.equal(std.max_completion_tokens, 1024);
  assert.equal("max_tokens" in std, false);

  const compat = buildOpenAIParams(
    { model: "deepseek-chat", system: "sys", messages: history, tools: [toolSpec], maxTokens: 2048 },
    {
      provider: "deepseek",
      compat: {
        maxTokensField: "max_tokens",
        supportsUsageInStreaming: false,
        supportsDeveloperRole: true,
        requiresNonNullAssistantContent: true,
      },
    },
  );
  assert.equal(compat.messages[0].role, "developer");
  assert.equal(compat.messages[2].content, "");
  assert.equal("stream_options" in compat, false);
  assert.equal(compat.max_tokens, 2048);
  assert.equal("max_completion_tokens" in compat, false);

  const msgs = toOpenAIMessages("sys", history, "m1", {
    provider: "custom",
    compat: { supportsDeveloperRole: true, requiresNonNullAssistantContent: true },
  });
  assert.equal(msgs[0].role, "developer");
  assert.equal(msgs[2].content, "");
});

function sseResponse(lines) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${lines.join("\n")}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("OpenAIProvider supports custom id, auth: 'none', headers, and modelOverrides without reading env", async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-env-should-not-leak";
  try {
    const seen = [];
    const fakeFetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(url),
        auth: headers.get("authorization"),
        custom: headers.get("x-custom"),
        modelHeader: headers.get("x-model"),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return sseResponse([
        `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "local-m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}`,
        "",
        "data: [DONE]",
        "",
      ]);
    };

    const provider = new OpenAIProvider({
      id: "ollama",
      baseURL: "http://127.0.0.1:11434/v1",
      model: "local-m",
      auth: "none",
      headers: { "x-custom": "yes" },
      compat: { supportsUsageInStreaming: false },
      modelOverrides: {
        "local-m": {
          maxTokens: 512,
          headers: { "x-model": "override" },
          compat: { maxTokensField: "max_tokens" },
        },
      },
      fetch: fakeFetch,
    });
    assert.equal(provider.id, "ollama");
    assert.equal(provider.defaultModel, "local-m");

    const deltas = [];
    const res = await provider.runTurn({ model: "local-m", system: "sys", messages: [user("hello")], tools: [] }, (e) =>
      deltas.push(e),
    );
    assert.equal(res.stopReason, "end_turn");
    assert.deepEqual(res.message.content, [{ type: "text", text: "hi" }]);
    assert.deepEqual(deltas, [{ type: "text_delta", text: "hi" }]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, null);
    assert.equal(seen[0].custom, "yes");
    assert.equal(seen[0].modelHeader, "override");
    assert.equal(seen[0].body.max_tokens, 512);
    assert.equal("stream_options" in seen[0].body, false);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test("AnthropicProvider supports custom id, authToken, auth: 'none', and compat overrides", async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-ant-env-should-not-leak";
  process.env.ANTHROPIC_AUTH_TOKEN = "tok-env-should-not-leak";
  try {
    const seen = [];
    const fakeFetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(url),
        auth: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
        custom: headers.get("x-gw"),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return sseResponse([
        "event: message_start",
        `data: ${JSON.stringify({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: "c1", stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } })}`,
        "",
        "event: content_block_start",
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
        "",
        "event: content_block_delta",
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "yo" } })}`,
        "",
        "event: content_block_stop",
        `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
        "",
        "event: message_delta",
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } })}`,
        "",
        "event: message_stop",
        `data: ${JSON.stringify({ type: "message_stop" })}`,
        "",
      ]);
    };

    const bearerProvider = new AnthropicProvider({
      id: "ant-gw",
      baseURL: "https://gateway.example.test",
      model: "c1",
      authToken: "my-bearer-token",
      headers: { "x-gw": "v1" },
      compat: { supportsFallbacks: false, supportsEagerToolInputStreaming: false, thinkingMode: "none" },
      fetch: fakeFetch,
    });
    assert.equal(bearerProvider.id, "ant-gw");
    const res = await bearerProvider.runTurn(
      { model: "c1", system: "sys", messages: [user("hi")], tools: [toolSpec] },
      () => {},
    );
    assert.equal(res.message.native.provider, "ant-gw");
    assert.equal(res.message.native.api, ANTHROPIC_MESSAGES_API);
    assert.equal(seen[0].auth, "Bearer my-bearer-token");
    assert.equal(seen[0].apiKey, null);
    assert.equal(seen[0].custom, "v1");
    assert.equal("thinking" in seen[0].body, false);
    assert.equal("fallbacks" in seen[0].body, false);

    const noAuthProvider = new AnthropicProvider({
      id: "ant-local",
      baseURL: "http://127.0.0.1:8080",
      model: "c1",
      auth: "none",
      compat: { supportsFallbacks: false, thinkingMode: "none" },
      fetch: fakeFetch,
    });
    await noAuthProvider.runTurn({ model: "c1", system: "sys", messages: [user("hi")], tools: [] }, () => {});
    assert.equal(seen[1].auth, null);
    assert.equal(seen[1].apiKey, null);
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
  }
});

test("ProviderRegistry.unregister removes factory and cached instance", () => {
  const registry = new ProviderRegistry().register("a", () => ({
    id: "a",
    defaultModel: "m1",
    async runTurn() {
      throw new Error("unused");
    },
  }));
  assert.equal(registry.has("a"), true);
  assert.equal(registry.get("a").id, "a");
  assert.equal(registry.unregister("a"), true);
  assert.equal(registry.has("a"), false);
  assert.deepEqual(registry.ids(), []);
  assert.throws(() => registry.get("a"), /Unknown provider/);
});
