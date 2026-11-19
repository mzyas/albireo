import { VaultError } from "./errors.js";

// Only version selectors are allowed in a base URL. Everything else (api_key, token, sig, ...)
// is a potential credential and must go into the encrypted vault instead.
const ALLOWED_QUERY = /^(api-version|version)$/;
const SAFE_QUERY_VALUE = /^[0-9A-Za-z._-]{1,32}$/;

// A short allowlist of non-credential headers users may need for gateways. Anything else could
// carry a secret, so it is rejected rather than stored (or echoed) in plaintext.
const ALLOWED_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
  "x-client",
  "x-gateway",
  "x-proxy",
  "x-request-id",
]);

/** Reject credentials and unknown parameters in a provider base URL's query string. */
export function assertSafeBaseURLQuery(url: URL, label: string): void {
  for (const [name, value] of url.searchParams) {
    if (!ALLOWED_QUERY.test(name.toLowerCase()) || !SAFE_QUERY_VALUE.test(value)) {
      throw new VaultError("invalid", `${label} may only contain a version query parameter; keep keys in the vault.`);
    }
  }
}

/** Whether a header name is known not to carry a credential. `null` (suppression) is handled by the caller. */
export function isAllowedHeader(name: string): boolean {
  return ALLOWED_HEADERS.has(name.toLowerCase());
}
