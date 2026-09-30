/**
 * 1AM Wallet integration via the Midnight DApp Connector API.
 *
 * Uses the actual types from the installed
 * `@midnight-ntwrk/dapp-connector-api` (v4): wallets inject themselves under
 * `window.midnight` as a flat object keyed by an implementation-defined
 * string. Each value is an `InitialAPI` exposing `name`, `icon`, `apiVersion`,
 * and `connect(networkId)`.
 *
 * There is no fixed, guaranteed key for any particular wallet, so this app
 * does not hardcode a key like `window.midnight['1am']`. Instead it scans
 * every injected wallet and selects the one whose declared identity
 * (`rdns` first, then `name`) identifies the wallet the user asked for.
 *
 * WHY MORE THAN ONE WALLET
 *   `ConnectedAPI` is wallet-agnostic: `balanceUnsealedTransaction(tx, {
 *   payFees?: boolean })` and `submitTransaction(tx)` are the same two calls
 *   for every wallet implementing the spec, and the wallet pays the fee from
 *   ITS OWN DUST. So a respondent whose 1AM Wallet cannot pay fees can submit
 *   through Lace instead, using Lace's own tDUST, with no change to the
 *   contract, the invitation-secret model, or the transaction flow.
 *
 *   Eligibility is unaffected by which wallet is used: `submitFeedback` proves
 *   only that the caller knows an invite secret whose commitment is a member
 *   of the public Merkle tree, and `registerParticipant` stores a 32-byte
 *   commitment leaf — never a wallet key. The secret, not the wallet, is what
 *   grants eligibility. See contracts/feedback.compact.
 */

import type {
  ConnectedAPI,
  InitialAPI,
} from "@midnight-ntwrk/dapp-connector-api";
import { EXPECTED_NETWORK_ID } from "./midnight/era.js";

/** The wallets this app can drive. Both implement the same v4 connector. */
export type WalletKind = "1am" | "lace";

/** How each wallet is named in the UI. */
export const WALLET_LABELS: Record<WalletKind, string> = {
  "1am": "1AM Wallet",
  lace: "Lace Wallet",
};

/**
 * How each wallet is named in a console line. Kept separate from the display
 * label so the existing 1AM diagnostic tag is preserved exactly.
 */
const WALLET_LOG_TAGS: Record<WalletKind, string> = {
  "1am": "1AM",
  lace: "Lace",
};

export type WalletConnectionState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | {
      status: "connected";
      address: string;
      networkId: string;
      api: ConnectedAPI;
      /** Which wallet the live `api` came from — the UI labels the connection. */
      walletKind: WalletKind;
    }
  | { status: "error"; reason: WalletErrorReason; message: string };

export type WalletErrorReason =
  | "not-installed"
  | "rejected"
  | "permission-rejected"
  | "wrong-network"
  | "disconnected"
  | "connection-failed";

const ONE_AM_NAME_PATTERN = /1am/i;

/** Which connector call failed, recorded for diagnosis only. */
type ConnectStage = "connect" | "getConfiguration" | "getUnshieldedAddress";

export type { ConnectedAPI, InitialAPI };

declare global {
  interface Window {
    midnight?: Record<string, InitialAPI>;
  }
}

/** Finds the injected 1AM wallet, if any. Never returns Lace or others. */
export function findOneAmWallet(): InitialAPI | null {
  if (typeof window === "undefined" || !window.midnight) return null;
  const wallets = Object.values(window.midnight);
  return wallets.find((wallet) => ONE_AM_NAME_PATTERN.test(wallet.name)) ?? null;
}

/**
 * Lace identifies itself with the reverse-DNS id `io.lace.wallet` — verified
 * against the installed connector API's `rdns` field and Lace's own published
 * connector behaviour. The name match is a fallback for Lace builds that do
 * not populate `rdns`.
 */
const LACE_RDNS_PATTERN = /(^|\.)lace\./i;
const LACE_NAME_PATTERN = /\blace\b/i;

/** Finds the injected Lace wallet, if any. Never returns 1AM or others. */
export function findLaceWallet(): InitialAPI | null {
  if (typeof window === "undefined" || !window.midnight) return null;
  const wallets = Object.values(window.midnight);
  return (
    wallets.find((wallet) => LACE_RDNS_PATTERN.test(String(wallet.rdns ?? ""))) ??
    wallets.find((wallet) => LACE_NAME_PATTERN.test(String(wallet.name ?? ""))) ??
    null
  );
}

const WALLET_FINDERS: Record<WalletKind, () => InitialAPI | null> = {
  "1am": findOneAmWallet,
  lace: findLaceWallet,
};

/** The injected wallet for `kind`, or null when that wallet is not installed. */
export function findWallet(kind: WalletKind): InitialAPI | null {
  return WALLET_FINDERS[kind]();
}

/**
 * Which supported wallets are actually injected right now.
 *
 * The UI uses this to explain why a button is unavailable instead of letting
 * the user click into a "not installed" error. Extensions inject slightly
 * after `DOMContentLoaded`, so callers may poll rather than read this once.
 */
export function listAvailableWallets(): WalletKind[] {
  return (Object.keys(WALLET_FINDERS) as WalletKind[]).filter(
    (kind) => findWallet(kind) !== null,
  );
}

/**
 * Connects to the chosen wallet on the app's configured Midnight network —
 * EXPECTED_NETWORK_ID from ./midnight/era.js (Preprod for the v9 era,
 * Preview for the retained ledger-v8 era).
 *
 * On success the live `ConnectedAPI` is carried on the returned state as
 * `api`. It is the only handle the caller can use to read configuration, build
 * providers and sign/submit, and the connector does not offer a way to
 * retrieve it again once `connect()` has resolved — so it must be handed back
 * rather than dropped here.
 *
 * The body is identical for every wallet kind because the connector contract
 * is; only discovery and the user-facing labels differ.
 */
export async function connectWallet(kind: WalletKind): Promise<WalletConnectionState> {
  const label = WALLET_LABELS[kind];
  const wallet = findWallet(kind);

  if (!wallet) {
    return {
      status: "error",
      reason: "not-installed",
      message: `${label} was not found. Install the ${label} extension and reload this page.`,
    };
  }

  try {
    let connected: ConnectedAPI;
    try {
      connected = await wallet.connect(EXPECTED_NETWORK_ID);
    } catch (error) {
      return classifyConnectError(error, "connect", kind);
    }

    // The connector takes NO network/environment argument: the network is fixed
    // by the `connect(networkId)` call above, and per spec the wallet supplies a
    // Configuration that matches it. This check verifies that rather than
    // requesting anything.
    let config: Awaited<ReturnType<ConnectedAPI["getConfiguration"]>>;
    try {
      config = await connected.getConfiguration();
    } catch (error) {
      return classifyConnectError(error, "getConfiguration", kind);
    }

    if (config.networkId !== EXPECTED_NETWORK_ID) {
      return {
        status: "error",
        reason: "wrong-network",
        message: `${label} is set to "${config.networkId}". Switch it to "${EXPECTED_NETWORK_ID}" in the wallet's network settings and reconnect.`,
      };
    }

    // v4 connector: getUnshieldedAddress resolves an OBJECT, not a string.
    try {
      const { unshieldedAddress } = await connected.getUnshieldedAddress();
      return {
        status: "connected",
        address: unshieldedAddress,
        networkId: config.networkId,
        api: connected,
        walletKind: kind,
      };
    } catch (error) {
      return classifyConnectError(error, "getUnshieldedAddress", kind);
    }
  } catch (error) {
    return classifyConnectError(error, "connect", kind);
  }
}

/** Connects to 1AM Wallet. Behavior is identical to `connectWallet("1am")`. */
export function connectOneAmWallet(): Promise<WalletConnectionState> {
  return connectWallet("1am");
}

/**
 * Connects to Lace. Lace pays the transaction fee from its own tDUST, so this
 * is the route for a respondent whose other wallet cannot pay DUST.
 */
export function connectLaceWallet(): Promise<WalletConnectionState> {
  return connectWallet("lace");
}

/**
 * Narrowly typed view of the connector's `APIError` shape (see
 * `@midnight-ntwrk/dapp-connector-api`): an `Error` carrying a `code` from
 * `ErrorCodes` and a `reason`. It is a TYPE, not a class, by design, so
 * `instanceof` is unreliable across the page/extension boundary — which is why
 * these fields are read structurally.
 */
type ConnectorAPIError = {
  type?: string;
  code?: string;
  reason?: string;
  message?: string;
  name?: string;
};

function asConnectorError(error: unknown): ConnectorAPIError | null {
  return typeof error === "object" && error !== null ? (error as ConnectorAPIError) : null;
}

/**
 * Classifies a failed `connect` / `getConfiguration` / `getUnshieldedAddress`
 * call.
 *
 * The connector's `code` is the authoritative signal and is preferred whenever
 * present, because the spec assigns each code a distinct meaning:
 *
 *   Rejected           one-time refusal (e.g. the user declined this prompt)
 *   PermissionRejected a standing refusal to permit an action, which per spec
 *                      keeps being returned for the rest of the session
 *   Disconnected       the connection to the wallet was lost
 *
 * A message-substring test alone cannot separate those: this project receives
 * real failures such as `{ code: 'InternalError', reason: 'Request failed' }`,
 * whose message matches none of the rejection words and would otherwise be
 * reported as an undifferentiated "please try again".
 *
 * The original error is always preserved so a failure can be diagnosed from the
 * browser console instead of being lost.
 */
function classifyConnectError(
  error: unknown,
  stage: ConnectStage,
  kind: WalletKind,
): WalletConnectionState {
  const connector = asConnectorError(error);
  const code = typeof connector?.code === "string" ? connector.code : undefined;
  const reason = typeof connector?.reason === "string" ? connector.reason : undefined;
  const message = connector?.message ?? (error instanceof Error ? error.message : String(error));
  const lower = message.toLowerCase();
  const label = WALLET_LABELS[kind];

  // Safe diagnostic: error identity and the stage that failed only. No
  // addresses, keys, or wallet state are logged.
  console.error(`[wallet] ${WALLET_LOG_TAGS[kind]} connect failed`, {
    stage,
    code: code ?? null,
    reason: reason ?? null,
    message,
    error,
  });

  const detail = reason ?? code ?? null;
  const withDetail = (text: string) => (detail ? `${text} (${detail})` : text);

  // Prefer the structured code; fall back to the message only for a wallet that
  // does not supply one.
  if (code === "PermissionRejected" || (!code && lower.includes("permission"))) {
    return {
      status: "error",
      reason: "permission-rejected",
      message: withDetail(
        `${label} did not grant this app permission. Allow this site in ${label}, or reconnect and approve the request.`,
      ),
    };
  }

  if (
    code === "Rejected" ||
    code === "InvalidRequest" ||
    (!code && (lower.includes("reject") || lower.includes("denied") || lower.includes("cancel")))
  ) {
    return {
      status: "error",
      reason: "rejected",
      message: withDetail(`Connection request was declined in ${label}.`),
    };
  }

  if (code === "Disconnected") {
    return {
      status: "error",
      reason: "disconnected",
      message: withDetail(`The connection to ${label} was lost. Reconnect and try again.`),
    };
  }

  return {
    status: "error",
    reason: "connection-failed",
    message: withDetail(`Could not connect to ${label}.`),
  };
}

/** Shortens an address for display: mn_addr1abc...wxyz */
export function shortenAddress(address: string): string {
  if (address.length <= 18) return address;
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}
