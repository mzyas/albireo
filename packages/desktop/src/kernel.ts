import { stat } from "node:fs/promises";
import { builtinTools, type ProviderRegistry, type Risk } from "@albireo/core";
import { defaultSessionsDir, SessionManager, startPanelServer } from "@albireo/server";
import { SessionStore } from "@albireo/store";
import {
  createVaultRegistry,
  defaultVaultDir,
  type KeyProtector,
  ProviderConfigStore,
  SecretManager,
  VaultStore,
} from "@albireo/vault";

/** The provider a first session uses when nothing says otherwise (the command line's default too). */
const DEFAULT_PROVIDER = "anthropic";

/** What the kernel is built on: the credentials, the provider definitions, the saved sessions. */
export interface Stores {
  dir: string;
  vault: VaultStore;
  config: ProviderConfigStore;
  registry: ProviderRegistry;
  store: SessionStore;
}

export interface StoresOptions {
  /** The config dir: vault, `providers.json` and `sessions/`. The per-user one, the command line's, by default. */
  dir?: string;
  /** Holder of the vault's master key. The platform's (the command line's too) by default, so both see one vault. */
  protector?: KeyProtector | null;
}

/**
 * Opens the same vault, provider definitions and saved sessions the command line uses. Credentials come
 * only from the vault; nothing is read from the environment.
 */
export async function openStores(opts: StoresOptions = {}): Promise<Stores> {
  const dir = opts.dir ?? defaultVaultDir();
  const [vault, config] = await Promise.all([
    VaultStore.open({ dir, protector: opts.protector }),
    ProviderConfigStore.open({ dir }),
  ]);
  return {
    dir,
    vault,
    config,
    registry: createVaultRegistry(vault, {}, config),
    store: new SessionStore(defaultSessionsDir(dir)),
  };
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export interface RecentUse {
  /** The workspace of the newest saved session whose folder still exists. */
  cwd?: string;
  /** The provider that session used, if it is still defined. */
  provider?: string;
}

/** Where the user left off: the app opens there, without asking. */
export async function recentUse(stores: Pick<Stores, "store" | "registry">): Promise<RecentUse> {
  let saved: Awaited<ReturnType<SessionStore["list"]>> = [];
  try {
    saved = await stores.store.list();
  } catch {
    return {};
  }
  for (const meta of saved) {
    if (!(await isDirectory(meta.cwd))) continue;
    return {
      cwd: meta.cwd,
      ...(meta.provider && stores.registry.has(meta.provider) ? { provider: meta.provider } : {}),
    };
  }
  return {};
}

export interface KernelOptions {
  /** The workspace of the first session. */
  cwd: string;
  provider?: string;
  /** The port to try first. If it is taken, any free one is used. */
  port?: number;
  /** Where the built panel is; the sibling `@albireo/panel` package's `dist/` by default. */
  publicDir?: URL;
  /** Risk levels sessions run without asking; reading only by default. */
  autoApprove?: Risk[];
  /** Called once, with a message for the user, when a conversation can't be saved. */
  onSaveError?: (message: string) => void;
}

export interface Kernel {
  /** The panel's address, with the run's token. */
  url: string;
  manager: SessionManager;
  /** Saves what is pending, then stops everything. Call it before the process exits. */
  close(): Promise<void>;
}

/**
 * The kernel the window shows: sessions in a manager, every one of them following the vault (a key saved
 * in the panel reaches all), served to the panel on the loopback address. The first session starts in
 * `cwd`; the panel can start and open others.
 */
export async function startKernel(stores: Stores, opts: KernelOptions): Promise<Kernel> {
  let reported = false;
  const manager = new SessionManager({
    registry: stores.registry,
    tools: builtinTools,
    autoApprove: opts.autoApprove ?? ["read"],
    store: stores.store,
    provider: opts.provider ?? DEFAULT_PROVIDER,
    cwd: opts.cwd,
    onSaveError: (err) => {
      if (reported) return;
      reported = true;
      opts.onSaveError?.(`The conversation could not be saved (${err.message}); it continues unsaved.`);
    },
  });
  const secrets = new SecretManager({ vault: stores.vault, registry: stores.registry, config: stores.config });
  manager.each((session) => secrets.track(session));
  try {
    await manager.create({ cwd: opts.cwd });
    const serve = (port: number | undefined) => startPanelServer(manager, { port, publicDir: opts.publicDir, secrets });
    let panel: Awaited<ReturnType<typeof startPanelServer>>;
    try {
      panel = await serve(opts.port);
    } catch (err) {
      // The port of the last run is taken by something else: any free one will do (the page's saved
      // preferences are lost this once, which is better than not starting).
      if (opts.port === undefined || (err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      panel = await serve(0);
    }
    return {
      url: panel.url,
      manager,
      close: async () => {
        await panel.close();
        await manager.dispose();
        secrets.dispose();
        stores.vault.lock();
      },
    };
  } catch (err) {
    await manager.dispose();
    secrets.dispose();
    throw err;
  }
}
