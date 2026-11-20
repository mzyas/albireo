import { ANTHROPIC_MESSAGES_API, type WireApi } from "@albireo/core";
import { VaultError } from "./errors.js";

// Only version selectors are allowed in a base URL. Everything else (api_key, token, sig, ...)
// is a potential credential and must go into the encrypted vault instead.
const ALLOWED_QUERY = /^(api-version|version)$/;
const SAFE_QUERY_VALUE = /^[0-9A-Za-z._-]{1,32}$/;
const MASK = "••••";

// Header names that look like they carry a credential. Gateways add their own metadata headers
// (betas, routing, tracing, attribution), so a fixed list of allowed names would keep breaking
// them; instead anything that reads like a key, token or password is refused. `WORDS` match
// anywhere in the lowercased name, `PARTS` only as a whole segment between "-", "_" or ".", and a
// segment ending in "token" always counts.
const CREDENTIAL_WORDS =
  /accesskey|apikey|authentication|authorization|bearer|cookie|credential|passw|privatekey|secret|signature/;
const CREDENTIAL_PARTS = new Set(["auth", "authn", "authz", "jwt", "key", "pwd", "sig"]);

/**
 * The one set of rules for a provider base URL, wherever it comes from (`providers.json`, a vault
 * override, or the combination a provider is about to be built with). Rejects anything but
 * http(s), embedded user info, a fragment (it would swallow the request path), and query
 * parameters other than version selectors (anything else may be a credential). The Anthropic SDK
 * appends the request path after any `?`, so `anthropic-messages` endpoints take no query at all,
 * not even an empty one; `href` is checked because `search` and `hash` are empty for a bare `?`
 * or `#`. `api` is left out only where the wire API isn't known yet.
 */
export function parseBaseURL(raw: string, label: string, api?: WireApi): URL {
  if (!URL.canParse(raw)) throw new VaultError("invalid", `${label} is not a valid URL.`);
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new VaultError("invalid", `${label} must start with http:// or https://.`);
  }
  if (url.username || url.password) {
    throw new VaultError("invalid", `${label} must not embed credentials; put keys in the vault.`);
  }
  if (url.href.includes("#")) {
    throw new VaultError("invalid", `${label} must not have a fragment (#…).`);
  }
  if (api === ANTHROPIC_MESSAGES_API && url.href.includes("?")) {
    throw new VaultError(
      "invalid",
      `${label} must not have a query string for an ${ANTHROPIC_MESSAGES_API} provider: the request path would end up inside it.`,
    );
  }
  for (const [name, value] of url.searchParams) {
    if (!isAllowedQueryParam(name, value)) {
      throw new VaultError(
        "invalid",
        `${label} may only contain a version query parameter (api-version or version); store credentials as the provider's API key in the vault.`,
      );
    }
  }
  return url;
}

/**
 * Why the base URL a provider would be built with can't be used, or undefined if it can. Run on
 * the combined result (vault override or definition), so a value saved under older rules or a
 * changed wire API can't slip through.
 */
export function baseURLProblem(baseURL: string, api: WireApi): string | undefined {
  try {
    parseBaseURL(baseURL, "The base URL", api);
    return undefined;
  } catch (err) {
    if (err instanceof VaultError) return err.message;
    throw err;
  }
}

/** Whether a header name looks like it carries a credential. `null` (suppression) is handled by the caller. */
export function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    CREDENTIAL_WORDS.test(lower) ||
    lower.split(/[-_.]/).some((part) => CREDENTIAL_PARTS.has(part) || part.endsWith("token"))
  );
}

/**
 * A base URL for display: query values other than allowed version selectors, embedded user info
 * and any fragment are masked. New URLs can't hold them, but an override saved before those
 * checks existed may.
 */
export function maskBaseURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return MASK;
  }
  const params = [...url.searchParams];
  const hasUserInfo = Boolean(url.username || url.password);
  const hasHash = url.href.includes("#");
  if (params.every(([name, v]) => isAllowedQueryParam(name, v)) && !hasUserInfo && !hasHash) {
    return value;
  }
  const query = params
    .map(([name, v]) => `${encodeURIComponent(name)}=${isAllowedQueryParam(name, v) ? encodeURIComponent(v) : MASK}`)
    .join("&");
  // Masked rather than dropped, so the URL shown still explains why the registry refuses it.
  const userInfo = hasUserInfo ? `${MASK}@` : "";
  return `${url.protocol}//${userInfo}${url.host}${url.pathname}${query ? `?${query}` : ""}${hasHash ? `#${MASK}` : ""}`;
}

function isAllowedQueryParam(name: string, value: string): boolean {
  return ALLOWED_QUERY.test(name.toLowerCase()) && SAFE_QUERY_VALUE.test(value);
}
