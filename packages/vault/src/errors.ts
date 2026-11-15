export type VaultErrorCode =
  /** The vault file does not exist yet. */
  | "uninitialized"
  /** The vault exists but its key is not in memory. */
  | "locked"
  /** Wrong passphrase, wrong master key, or a tampered/corrupted file (AES-GCM cannot tell these apart). */
  | "bad_key"
  /** Bad input from the caller. */
  | "invalid"
  /** The OS credential store is missing or refused the request. */
  | "unavailable"
  /** The vault file is unreadable or in an unsupported format. */
  | "corrupt";

/** Messages are safe to show to the user: they never contain key material or subprocess output. */
export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}
