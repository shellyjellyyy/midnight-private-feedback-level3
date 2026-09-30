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
 * every injected wallet and selects the one whose declared `name` identifies
 * it as 1AM. This is deliberate: it is the officially documented way to
 * target a specific wallet, and it means this code keeps working even if
 * 1AM changes its internal key. Lace, or any other injected wallet, is
 * never selected by this app.
 */

import type {
  ConnectedAPI,
  InitialAPI,
} from "@midnight-ntwrk/dapp-connector-api";
import { EXPECTED_NETWORK_ID } from "./midnight/era.js";

export type WalletConnectionState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; address: string; networkId: string }
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
 * Connects to 1AM Wallet on the app's configured Midnight network —
 * EXPECTED_NETWORK_ID from ./midnight/era.js (Preprod for the v9 era,
 * Preview for the retained ledger-v8 era).
 *
 * Distinguishes the specific failure modes the UI needs to react to:
 * wallet not installed, the user rejecting the connection prompt, the
 * wallet being on the wrong network, and any other connection failure.
 */
export async function connectOneAmWallet(): Promise<WalletConnectionState> {
  const wallet = findOneAmWallet();

  if (!wallet) {
    return {
      status: "error",
      reason: "not-installed",
      message: "1AM Wallet was not found. Install the 1AM extension and reload this page.",
    };
  }

  try {
    let connected: ConnectedAPI;
    try {
      connected = await wallet.connect(EXPECTED_NETWORK_ID);
    } catch (error) {
      return classifyConnectError(error, "connect");
    }

    // The connector takes NO network/environment argument: the network is fixed
    // by the `connect(networkId)` call above, and per spec the wallet supplies a
    // Configuration that matches it. This check verifies that rather than
    // requesting anything.
    let config: Awaited<ReturnType<ConnectedAPI["getConfiguration"]>>;
    try {
      config = await connected.getConfiguration();
    } catch (error) {
      return classifyConnectError(error, "getConfiguration");
    }

    if (config.networkId !== EXPECTED_NETWORK_ID) {
      return {
        status: "error",
        reason: "wrong-network",
        message: `1AM Wallet is set to "${config.networkId}". Switch it to "${EXPECTED_NETWORK_ID}" in the wallet's network settings and reconnect.`,
      };
    }

    // v4 connector: getUnshieldedAddress resolves an OBJECT, not a string.
    try {
      const { unshieldedAddress } = await connected.getUnshieldedAddress();
      return { status: "connected", address: unshieldedAddress, networkId: config.networkId };
    } catch (error) {
      return classifyConnectError(error, "getUnshieldedAddress");
    }
  } catch (error) {
    return classifyConnectError(error, "connect");
  }
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
function classifyConnectError(error: unknown, stage: ConnectStage): WalletConnectionState {
  const connector = asConnectorError(error);
  const code = typeof connector?.code === "string" ? connector.code : undefined;
  const reason = typeof connector?.reason === "string" ? connector.reason : undefined;
  const message = connector?.message ?? (error instanceof Error ? error.message : String(error));
  const lower = message.toLowerCase();

  // Safe diagnostic: error identity and the stage that failed only. No
  // addresses, keys, or wallet state are logged.
  console.error("[wallet] 1AM connect failed", {
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
        "1AM Wallet did not grant this app permission. Open 1AM Wallet → authorized DApps " +
          "and allow this site, or reconnect and approve the request.",
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
      message: withDetail("Connection request was declined in 1AM Wallet."),
    };
  }

  if (code === "Disconnected") {
    return {
      status: "error",
      reason: "disconnected",
      message: withDetail("The connection to 1AM Wallet was lost. Reconnect and try again."),
    };
  }

  return {
    status: "error",
    reason: "connection-failed",
    message: withDetail("Could not connect to 1AM Wallet."),
  };
}

/** Shortens an address for display: mn_addr1abc...wxyz */
export function shortenAddress(address: string): string {
  if (address.length <= 18) return address;
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}
