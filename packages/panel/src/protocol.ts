// Wire types shared with @albireo/server. They come straight from the kernel and the vault
// (type-only imports, erased at build time), so a protocol change breaks `tsc -b` here.
import type { InstructionInfo, KernelEvent, LoggedEvent, Snapshot } from "@albireo/core";
import type {
  ChangedFile,
  ChangeStatus,
  Changes,
  CreateSessionBody,
  DesktopBridge,
  FileDiff,
  FileList,
  FilePreview,
  SessionSummary,
  SessionsResponse,
  WorkspaceFailure,
} from "@albireo/server/protocol";
import type { ProviderSecretView, SecretsStatus } from "@albireo/vault";

export type {
  ChangedFile,
  ChangeStatus,
  Changes,
  CreateSessionBody,
  DesktopBridge,
  FileDiff,
  FileList,
  FilePreview,
  InstructionInfo,
  KernelEvent,
  ProviderSecretView,
  SecretsStatus,
  SessionSummary,
  SessionsResponse,
  WorkspaceFailure,
};

export type ApprovalRequest = Extract<KernelEvent, { type: "approval_request" }>;
export type SnapshotEvent = { type: "snapshot" } & Snapshot;
/** `secrets_changed` and `sessions_changed` go to every open stream: re-fetch `/secrets` or `/sessions`. */
export type ServerEvent = SnapshotEvent | { type: "secrets_changed" } | { type: "sessions_changed" } | LoggedEvent;

/** `GET /secrets`: `enabled: false` when the server was started without a vault. */
export type SecretsResponse = SecretsStatus | { enabled: false };

/** What the page asks of the session it shows; the `session` field is added when it is sent. */
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
