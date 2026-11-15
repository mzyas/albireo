export { type KdfParams, type Protection, SCRYPT_PARAMS, VAULT_VERSION, type VaultEnvelope } from "./crypto.js";
export { VaultError, type VaultErrorCode } from "./errors.js";
export { defaultVaultDir } from "./fs.js";
export {
  type ProviderSecretView,
  type ProviderUpdate,
  SecretManager,
  type SecretManagerOptions,
  type SecretsStatus,
} from "./manager.js";
export {
  DpapiProtector,
  defaultProtector,
  type KeyProtector,
  MacKeychainProtector,
  MemoryKeyProtector,
  SecretServiceProtector,
} from "./protector.js";
export {
  createVaultRegistry,
  hasProviderKey,
  maskApiKey,
  type ProviderFactory,
  type ResolvedProviderConfig,
  redactError,
  registerVaultProviders,
  UnconfiguredProvider,
} from "./registry.js";
export {
  isProviderId,
  MIN_PASSPHRASE,
  PROVIDER_IDS,
  type ProviderId,
  type ProviderPatch,
  type ProviderSecret,
  VAULT_FILE,
  type VaultSecrets,
  type VaultState,
  VaultStore,
  type VaultStoreOptions,
} from "./store.js";
