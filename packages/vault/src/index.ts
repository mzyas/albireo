export { type KdfParams, type Protection, SCRYPT_PARAMS, VAULT_VERSION, type VaultEnvelope } from "./crypto.js";
export { VaultError, type VaultErrorCode } from "./errors.js";
export { defaultVaultDir } from "./fs.js";
export {
  type ProviderConfigUpsert,
  type ProviderConfigUpsertStatus,
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
  CUSTOM_ANTHROPIC_COMPAT,
  DEFAULT_ANTHROPIC_COMPAT,
  DEFAULT_OPENAI_COMPAT,
  defaultProviderDefinitions,
  PROVIDERS_FILE,
  type ProviderCompat,
  type ProviderConfigEntry,
  type ProviderConfigGuard,
  type ProviderConfigReload,
  ProviderConfigStore,
  type ProviderConfigStoreOptions,
  type ProviderConfigUpsertResult,
  type ProviderModelConfig,
  type ProvidersFile,
  parseProvidersFile,
  type ResolvedProviderDefinition,
  validateProviderEntry,
} from "./providers.js";
export {
  createVaultRegistry,
  hasProviderKey,
  isProviderReady,
  maskApiKey,
  type ProviderFactory,
  type ResolvedProviderConfig,
  redactError,
  registerVaultProviders,
  UnconfiguredProvider,
} from "./registry.js";
export {
  BUILTIN_PROVIDER_IDS,
  type BuiltinProviderId,
  isBuiltinProviderId,
  isProviderId,
  isValidProviderId,
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
