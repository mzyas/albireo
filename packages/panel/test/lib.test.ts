import assert from "node:assert/strict";
import test from "node:test";
import { formatTokens, truncate } from "../src/lib/format.ts";
import { decodeEntities, safeHref } from "../src/lib/markdown.ts";
import { approvalBody, toolSummary } from "../src/lib/tools.ts";
import {
  addProviderBlock,
  attention,
  buildCustomProviderPayload,
  type CustomProviderInput,
  formsUsable,
  modelSuggestions,
  providerBadge,
} from "../src/lib/vault.ts";
import type { ProviderSecretView, SecretsStatus } from "../src/protocol.ts";

test("decodeEntities handles the entities the lexer leaves in text", () => {
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;"), `a & b <c> "d" 'e' A`);
  assert.equal(decodeEntities("&unknown; &#99999999999;"), "&unknown; &#99999999999;");
});

test("safeHref only lets web and mail links through", () => {
  assert.equal(safeHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("  JavaScript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref("/relative"), null);
  // An entity-encoded scheme must not slip past the check.
  assert.equal(safeHref("javascript&colon;alert(1)"), null);
});

test("toolSummary prefers the command or path", () => {
  assert.equal(toolSummary({ command: "pnpm test\nsecond line" }), "pnpm test");
  assert.equal(toolSummary({ path: "src/a.ts", contents: "x" }), "src/a.ts");
  assert.equal(toolSummary({ q: 1 }), '{"q":1}');
  assert.equal(toolSummary(undefined), "undefined");
  assert.ok(toolSummary({ q: "x".repeat(500) }).length <= 120);
});

test("approvalBody shows what will run or be written, in full up to a limit", () => {
  assert.deepEqual(approvalBody("run_command", { command: "rm -rf build" }), {
    label: "Command",
    text: "rm -rf build",
  });
  const w = approvalBody("write_file", { path: "a.txt", contents: "y".repeat(5000) });
  assert.equal(w?.label, "a.txt");
  assert.match(w?.text ?? "", /\[1000 more characters\]$/);
  assert.equal(approvalBody("other", { a: 1 }), null);
  assert.equal(approvalBody("run_command", null), null);
});

test("formatTokens and truncate", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1234), "1.2k");
  assert.equal(formatTokens(45_600), "46k");
  assert.equal(formatTokens(2_500_000), "2.5M");
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});

function status(over: Partial<SecretsStatus> = {}): SecretsStatus {
  return {
    enabled: true,
    state: "unlocked",
    protection: "os-keychain",
    keychain: null,
    needsUnlock: false,
    refreshPending: false,
    providerOrder: ["anthropic", "local"],
    providers: {
      anthropic: view({ id: "anthropic", configured: true, hasKey: true }),
      local: view({ id: "local", auth: "none", configured: true }),
    },
    ...over,
  } as SecretsStatus;
}

function view(over: Partial<ProviderSecretView>): ProviderSecretView {
  return {
    name: "Anthropic",
    api: "anthropic-messages",
    auth: "api-key",
    builtin: true,
    configured: false,
    hasKey: false,
    keyHint: null,
    defaultBaseURL: "https://example.test",
    defaultModel: "default-model",
    models: [],
    ...over,
  } as ProviderSecretView;
}

test("attention: a ready provider needs nothing; a missing key, locked vault or bad URL does", () => {
  assert.equal(attention(status(), "anthropic").needed, false);
  assert.equal(attention(status(), "local").needed, false);

  const noKey = status({ providers: { anthropic: view({ id: "anthropic", configured: false }) } as never });
  assert.deepEqual(attention(noKey, "anthropic"), { needed: true, reason: "No anthropic key saved" });

  assert.equal(attention(status({ state: "locked", needsUnlock: true }), "anthropic").needed, true);

  const bad = status({
    providers: {
      anthropic: view({ id: "anthropic", configured: false, hasKey: true, problem: "bad base URL" }),
    } as never,
  });
  assert.equal(attention(bad, "anthropic").reason, "bad base URL");

  // A local endpoint stays fine even if the vault is locked, unless something else is wrong.
  assert.equal(attention(status({ state: "locked" }), "local").needed, false);
  assert.equal(attention(status({ configError: "bad json" }), "local").reason, "bad json");
});

test("forms are usable once the vault is open or will open on first save", () => {
  assert.equal(formsUsable(status()), true);
  assert.equal(formsUsable(status({ state: "uninitialized", protection: "os-keychain" })), true);
  assert.equal(formsUsable(status({ state: "uninitialized", protection: "passphrase" })), false);
  assert.equal(formsUsable(status({ state: "locked" })), false);
});

test("adding a provider is blocked while the vault is locked or broken", () => {
  assert.equal(addProviderBlock(status()), "");
  assert.match(addProviderBlock(status({ needsUnlock: true })), /Unlock/);
  assert.match(addProviderBlock(status({ error: "corrupt" })), /Fix the vault/);
});

test("provider badge and model suggestions", () => {
  assert.deepEqual(providerBadge(view({ hasKey: true })), { text: "encrypted", ok: true });
  assert.deepEqual(providerBadge(view({})), { text: "not configured", ok: false });
  assert.deepEqual(providerBadge(view({ auth: "none" })), { text: "no key needed", ok: true });
  assert.deepEqual(providerBadge(view({ hasKey: true, problem: "x" })), { text: "unusable", ok: false });
  assert.deepEqual(modelSuggestions(view({ model: "mine", models: [{ id: "a" }, { id: "default-model" }] })), [
    "mine",
    "default-model",
    "a",
  ]);
  assert.deepEqual(modelSuggestions(undefined), []);
});

const customInput: CustomProviderInput = {
  id: " deepseek ",
  name: " ",
  api: "openai-completions",
  auth: "api-key",
  baseURL: " https://api.deepseek.com/v1 ",
  defaultModel: "deepseek-chat",
  extraModels: " deepseek-reasoner, ,deepseek-chat ",
  openai: { maxTokensField: "max_tokens", usageInStreaming: true, nonNullContent: false, developerRole: false },
  anthropic: { thinkingMode: "none", eagerToolInput: false, fallbacks: false },
};

test("the custom provider payload is trimmed, de-duplicated, and carries only its wire API's compat", () => {
  assert.deepEqual(buildCustomProviderPayload(customInput), {
    id: "deepseek",
    api: "openai-completions",
    auth: "api-key",
    baseURL: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
    compat: {
      maxTokensField: "max_tokens",
      supportsUsageInStreaming: true,
      requiresNonNullAssistantContent: false,
      supportsDeveloperRole: false,
    },
  });
  const anthropic = buildCustomProviderPayload({ ...customInput, name: "DS", api: "anthropic-messages" });
  assert.equal(anthropic.name, "DS");
  assert.deepEqual(anthropic.compat, {
    thinkingMode: "none",
    supportsEagerToolInputStreaming: false,
    supportsFallbacks: false,
  });
  // The key never travels with the provider definition.
  assert.equal("apiKey" in anthropic, false);
});
