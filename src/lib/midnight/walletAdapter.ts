/**
 * Adapts the connected DApp Connector API (1AM Wallet) into the two provider
 * seams midnight-js needs from a wallet:
 *
 *   - `WalletProvider`  — balances a proven-but-unbalanced transaction
 *   - `MidnightProvider` — submits a balanced, sealed transaction
 *
 * The connector moves transactions as hex strings (`balanceUnsealedTransaction`
 * / `submitTransaction`), while midnight-js 5.0-beta moves live ledger-v9
 * objects through the current-era seam. This adapter is the bridge, and the
 * pattern is taken from the official `midnightntwrk/midnight-wallet-dapp`
 * starter (`src/lib/walletAdapter.ts`), which targets this exact SDK line:
 * serialize to hex for the wallet, deserialize the wallet's answer back into a
 * ledger-v9 `Transaction`.
 *
 * The connector answers `submitTransaction` with nothing, so the transaction id
 * used for tracking is read from the transaction's own identifiers BEFORE it is
 * submitted.
 */

import {
  createMidnightProviderFromArms,
  createWalletProviderFromArms,
  type UnboundTransaction,
} from "@midnight-ntwrk/midnight-js-types";
import {
  Transaction,
  type CoinPublicKey,
  type EncPublicKey,
  type FinalizedTransaction,
} from "@midnightntwrk/ledger-v9";
import { reportSeamFailure } from "./devSeamDiagnostic.js";

/** Only the connector methods the two seams actually reach for. */
export type WalletSeamConnector = Pick<
  import("@midnight-ntwrk/dapp-connector-api").ConnectedAPI,
  "balanceUnsealedTransaction" | "submitTransaction"
>;

export function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToUint8Array(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/, "");
  const matches = cleaned.match(/.{1,2}/g);
  if (!matches) return new Uint8Array();
  return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
}

/** The two key readers sit outside the arms: they are wallet facts, not era facts. */
export type WalletKeyReaders = {
  readonly getCoinPublicKey: () => CoinPublicKey;
  readonly getEncryptionPublicKey: () => EncPublicKey;
};

/**
 * Runs a seam call, and under a dev build reports a sanitized projection of any
 * rejection before re-throwing it UNCHANGED.
 *
 * The error is re-thrown as-is so the SDK's own `Ledger8SeamFailedError` and
 * the user-facing redaction behave exactly as they do in production. Nothing
 * about the failure is altered, only observed — and only on a dev server, since
 * the diagnostic body is behind `import.meta.env.DEV`.
 */
async function balanceReporting<T>(seam: "balanceTx", call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    reportSeamFailure(seam, error);
    throw error;
  }
}

/**
 * Builds the wallet + submission providers from a connected connector API.
 *
 * The current-era arm moves a live ledger-v9 object; the retained (v8) arm
 * moves bytes. Both send the same hex string to the wallet, which deserializes
 * according to the chain it is connected to.
 */
export function createWalletProvidersFromConnectedAPI(
  connectedAPI: WalletSeamConnector,
  keys: WalletKeyReaders,
): {
  walletProvider: ReturnType<typeof createWalletProviderFromArms>;
  midnightProvider: ReturnType<typeof createMidnightProviderFromArms>;
} {
  const walletProvider = createWalletProviderFromArms({
    getCoinPublicKey: keys.getCoinPublicKey,
    getEncryptionPublicKey: keys.getEncryptionPublicKey,
    currentEra: async (tx: UnboundTransaction): Promise<FinalizedTransaction> => {
      const serialized = uint8ArrayToHex(tx.serialize());
      // DEV-ONLY: tree-shaken out of production builds (import.meta.env.DEV
      // folds to false). The transaction itself is never passed to it.
      const result = import.meta.env.DEV
        ? await balanceReporting("balanceTx", () =>
            connectedAPI.balanceUnsealedTransaction(serialized),
          )
        : await connectedAPI.balanceUnsealedTransaction(serialized);
      const resultBytes = hexToUint8Array(result.tx);
      return Transaction.deserialize(
        "signature",
        "proof",
        "binding",
        resultBytes,
      ) as FinalizedTransaction;
    },
    retainedEras: {
      v8: async (txBytes: Uint8Array): Promise<Uint8Array> => {
        const serialized = uint8ArrayToHex(txBytes);
        const result = import.meta.env.DEV
          ? await balanceReporting("balanceTx", () =>
              connectedAPI.balanceUnsealedTransaction(serialized),
            )
          : await connectedAPI.balanceUnsealedTransaction(serialized);
        return hexToUint8Array(result.tx);
      },
    },
  });

  const midnightProvider = createMidnightProviderFromArms({
    currentEra: async (tx: FinalizedTransaction): Promise<string> => {
      // Read the id before submitting — past that call the transaction is on
      // its way, and a failure here would be reported as a failed submission
      // the user cannot retry.
      const [txId] = tx.identifiers();
      if (txId === undefined) {
        throw new Error(
          "The transaction carries no identifier, so it cannot be tracked once submitted.",
        );
      }
      await connectedAPI.submitTransaction(uint8ArrayToHex(tx.serialize()));
      return txId;
    },
    retainedEras: {
      v8: async (txBytes: Uint8Array): Promise<string> => {
        const { Transaction: RetainedTransaction } = await import(
          "@midnight-ntwrk/midnight-js-protocol/v8"
        );
        const [txId] = RetainedTransaction.deserialize(
          "signature",
          "proof",
          "binding",
          txBytes,
        ).identifiers();
        if (txId === undefined) {
          throw new Error(
            "The transaction carries no identifier, so it cannot be tracked once submitted.",
          );
        }
        try {
          await connectedAPI.submitTransaction(uint8ArrayToHex(txBytes));
        } catch (error) {
          // DEV-ONLY observation; the rejection is re-thrown unchanged so the
          // SDK's own handling and the user-facing text are unaffected.
          if (import.meta.env.DEV) reportSeamFailure("submitTx", error);
          throw error;
        }
        return txId;
      },
    },
  });

  return { walletProvider, midnightProvider };
}
