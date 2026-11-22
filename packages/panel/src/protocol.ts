// Wire types shared with @albireo/server. They come straight from the kernel and the vault
// (type-only imports, erased at build time), so a protocol change breaks `tsc -b` here.
import type { InstructionInfo, KernelEvent, LoggedEvent, Snapshot } from "@albireo/core";
import type {
  ChangedFile,
  ChangeStatus,
  Changes,
  FileDiff,
  FileList,
  FilePreview,
  WorkspaceFailure,
} from "@albireo/server/protocol";
import type { ProviderSecretView, SecretsStatus } from "@albireo/vault";

export type {
  ChangedFile,
  ChangeStatus,
  Changes,
  FileDiff,
  FileList,
  FilePreview,
  InstructionInfo,
  KernelEvent,
  ProviderSecretView,
  SecretsStatus,
  WorkspaceFailure,
};

export type ApprovalRequest = Extract<KernelEvent, { type: "approval_request" }>;
export type SnapshotEvent = { type: "snapshot" } & Snapshot;
export type ServerEvent = SnapshotEvent | { type: "secrets_changed" } | LoggedEvent;

/** `GET /secrets`: `enabled: false` when the server was started without a vault. */
export type SecretsResponse = SecretsStatus | { enabled: false };

export type Command =
  | { type: "send"; text: string }
  | { type: "approve"; id: string; allow: boolean }
  | { type: "abort" }
  | { type: "retry" }
  | { type: "switch"; provider: string; model?: string };

/** Body of `POST /secrets/provider`. Only fields the user actually changed are sent. */
export interface ProviderPatchBody {
  provider: string;
  apiKey?: string;
  clearApiKey?: boolean;
  baseURL?: string;
  model?: string;
}
