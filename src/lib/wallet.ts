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
  | "wrong-network"
  | "connection-failed";

const ONE_AM_NAME_PATTERN = /1am/i;

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
    const connected = await wallet.connect(EXPECTED_NETWORK_ID);

    const config = await connected.getConfiguration();
    if (config.networkId !== EXPECTED_NETWORK_ID) {
      return {
        status: "error",
        reason: "wrong-network",
        message: `1AM Wallet is set to "${config.networkId}". Switch it to "${EXPECTED_NETWORK_ID}" in the wallet's network settings and reconnect.`,
      };
    }

    // v4 connector: getUnshieldedAddress resolves an OBJECT, not a string.
    const { unshieldedAddress } = await connected.getUnshieldedAddress();

    return { status: "connected", address: unshieldedAddress, networkId: config.networkId };
  } catch (error) {
    return classifyConnectError(error);
  }
}

function classifyConnectError(error: unknown): WalletConnectionState {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes("reject") || lower.includes("denied") || lower.includes("cancel")) {
    return {
      status: "error",
      reason: "rejected",
      message: "Connection request was declined in 1AM Wallet.",
    };
  }

  return {
    status: "error",
    reason: "connection-failed",
    message: "Could not connect to 1AM Wallet. Please try again.",
  };
}

/** Shortens an address for display: mn_addr1abc...wxyz */
export function shortenAddress(address: string): string {
  if (address.length <= 18) return address;
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}
