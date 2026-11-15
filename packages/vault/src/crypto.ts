import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt } from "node:crypto";
import { VaultError } from "./errors.js";

export const VAULT_VERSION = 1;
/** Fixed for format version 1; changing them means a new version. */
export const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1 });
/** 128·N·r is exactly Node's default scrypt `maxmem` (32 MiB), and OpenSSL needs a little more. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const HKDF_INFO = "albireo-vault-v1";
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

export type Protection = "os-keychain" | "passphrase";

export type KdfParams =
  | { mode: "os-keychain"; salt: string }
  | { mode: "passphrase"; salt: string; scrypt: { N: number; r: number; p: number } };

/** On-disk format of `vault.enc.json`. Everything but the ciphertext is public. */
export interface VaultEnvelope {
  version: typeof VAULT_VERSION;
  kdf: KdfParams;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function newKdf(mode: Protection): KdfParams {
  const salt = randomBytes(SALT_LEN).toString("base64");
  return mode === "passphrase" ? { mode, salt, scrypt: { ...SCRYPT_PARAMS } } : { mode, salt };
}

/** Vault key for os-keychain mode: HKDF-SHA256 over the random master key held by the OS. */
export function deriveFromMasterKey(masterKey: Buffer, kdf: KdfParams): Buffer {
  if (masterKey.length !== KEY_LEN) throw new VaultError("bad_key", "The stored master key has the wrong length.");
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.from(kdf.salt, "base64"), HKDF_INFO, KEY_LEN));
}

/** Vault key for passphrase mode: scrypt with the fixed version-1 parameters. */
export function deriveFromPassphrase(passphrase: string, kdf: KdfParams): Promise<Buffer> {
  if (kdf.mode !== "passphrase") throw new VaultError("invalid", "This vault is not protected by a passphrase.");
  const { N, r, p } = kdf.scrypt;
  return new Promise((resolve, reject) => {
    scrypt(passphrase, Buffer.from(kdf.salt, "base64"), KEY_LEN, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * Additional authenticated data: the header fields, serialized in a fixed key order so that the
 * same header always yields the same bytes. Tampering with `version` or `kdf` fails decryption.
 */
function aad(version: number, kdf: KdfParams): Buffer {
  const canonical =
    kdf.mode === "passphrase"
      ? { mode: kdf.mode, salt: kdf.salt, scrypt: { N: kdf.scrypt.N, r: kdf.scrypt.r, p: kdf.scrypt.p } }
      : { mode: kdf.mode, salt: kdf.salt };
  return Buffer.from(JSON.stringify({ version, kdf: canonical }), "utf8");
}

/** Encrypt with AES-256-GCM under a fresh random IV. */
export function seal(key: Buffer, kdf: KdfParams, plaintext: Buffer): VaultEnvelope {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(aad(VAULT_VERSION, kdf));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: VAULT_VERSION,
    kdf,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function unseal(key: Buffer, env: VaultEnvelope): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"), { authTagLength: TAG_LEN });
    decipher.setAAD(aad(env.version, env.kdf));
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(env.ciphertext, "base64")), decipher.final()]);
  } catch {
    throw new VaultError("bad_key", "Could not decrypt the vault: wrong passphrase or key, or the file was modified.");
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function b64(v: unknown, bytes?: number): v is string {
  return typeof v === "string" && BASE64.test(v) && (bytes === undefined || Buffer.from(v, "base64").length === bytes);
}

/** Strictly validate the file before any key derivation runs on its parameters. */
export function parseEnvelope(text: string): VaultEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VaultError("corrupt", "The vault file is not valid JSON.");
  }
  const e = raw as Partial<VaultEnvelope> & { kdf?: Record<string, unknown> };
  if (typeof e !== "object" || e === null) throw new VaultError("corrupt", "The vault file is malformed.");
  if (e.version !== VAULT_VERSION) throw new VaultError("corrupt", `Unsupported vault version: ${String(e.version)}.`);
  const kdf = e.kdf;
  if (typeof kdf !== "object" || kdf === null || !b64(kdf.salt, SALT_LEN)) {
    throw new VaultError("corrupt", "The vault file has an invalid kdf header.");
  }
  let parsedKdf: KdfParams;
  if (kdf.mode === "os-keychain") {
    parsedKdf = { mode: "os-keychain", salt: kdf.salt };
  } else if (kdf.mode === "passphrase") {
    const s = kdf.scrypt as Record<string, unknown> | undefined;
    // Exact match: a tampered file must not be able to make us run an expensive scrypt.
    if (!s || s.N !== SCRYPT_PARAMS.N || s.r !== SCRYPT_PARAMS.r || s.p !== SCRYPT_PARAMS.p) {
      throw new VaultError("corrupt", "The vault file has unsupported scrypt parameters.");
    }
    parsedKdf = { mode: "passphrase", salt: kdf.salt, scrypt: { ...SCRYPT_PARAMS } };
  } else {
    throw new VaultError("corrupt", "The vault file has an unknown protection mode.");
  }
  if (!b64(e.iv, IV_LEN) || !b64(e.tag, TAG_LEN) || !b64(e.ciphertext)) {
    throw new VaultError("corrupt", "The vault file has invalid ciphertext fields.");
  }
  return { version: VAULT_VERSION, kdf: parsedKdf, iv: e.iv, tag: e.tag, ciphertext: e.ciphertext };
}
