/**
 * Assembles the full `MidnightProviders` set for the browser from the
 * connected DApp Connector API (1AM Wallet), per the pattern of the official
 * `midnightntwrk/midnight-wallet-dapp` starter — with ONE BUNDLE PER ERA,
 * exactly as the starter does (its `currentEraProviders` /
 * `retainedEraProviders` pair):
 *
 *   - v9 (default):  proving prefers the wallet's delegated proving provider
 *                    (getProvingProvider) with the ledger-v9 cost model,
 *                    falling back to the wallet's proof server. ZK artifact
 *                    integrity is verified against compiler/contract-manifest.
 *   - v8-preview:    proving goes through the wallet's proof server
 *                    (proverServerUri), and artifact integrity uses the
 *                    'require-if-present' mode — compactc 0.31.1 emits no
 *                    contract-manifest.json, so the fail-closed default
 *                    'require' would refuse every intact retained artifact
 *                    (official starter's rationale, verbatim).
 *
 * Every provider here is a real implementation from the SDK:
 *
 *   - privateStateProvider: level (IndexedDB in the browser), password-encrypted
 *   - publicDataProvider:   the indexer GraphQL endpoint reported by the WALLET
 *   - zkConfigProvider:     FetchZkConfigProvider against this app's own origin
 *   - proofProvider:        era-specific, as above
 *   - walletProvider:       balances via the connector's
 *                           `balanceUnsealedTransaction`
 *   - midnightProvider:     submits via the connector's `submitTransaction`
 *
 * Nothing here fakes success: any provider that cannot be constructed throws,
 * and that error propagates to the UI. The ledger-v9 runtime is reached only
 * through dynamic imports inside the v9 arm, so a Preview build never pulls
 * it into its module graph (and vice versa for the ledger8 runtime).
 */

import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
// Kept as a top-of-file import so the v9 arm fails visibly if ledger-v9 is
// absent; the Preview-era arm never imports it at all.
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type {
  MidnightProviders,
  PrivateStateId,
} from "@midnight-ntwrk/midnight-js-types";
import type { ZkArtifactIntegrityMode } from "@midnight-ntwrk/midnight-js-utils";
import { createWalletProvidersFromConnectedAPI } from "./walletAdapter.js";
import type { FeedbackPrivateState } from "./witnesses.js";
import type { FeedbackCircuitId } from "./contract.js";
import type { FeedbackCircuitIdV8 } from "./contract-v8.js";
import { ERA, ZK_HTTP_ROUTE } from "./era.js";

/**
 * The string every stored private state is keyed under. Witnesses read the
 * caller's invite secret from the state stored here.
 */
export const FEEDBACK_PRIVATE_STATE_ID = "feedbackPrivateState" satisfies PrivateStateId;

/**
 * Storage password for the level-backed private state store.
 *
 * The invite secret itself is also held in localStorage by the app (it is the
 * value the user must keep to retain eligibility); this password only guards
 * the provider's own encrypted at-rest store against casual access on a shared
 * machine. It is derived from a constant application salt — NOT from any
 * secret — so it must not be relied on as the sole protection for high-value
 * assets. For a survey response this trade-off is acceptable and keeps the UX
 * passwordless.
 */
function storagePassword(): string {
  return "MidnightPrivateFeedback:local-storage:v1";
}

export type FeedbackProviders = MidnightProviders<
  FeedbackCircuitId,
  typeof FEEDBACK_PRIVATE_STATE_ID,
  FeedbackPrivateState
>;

export type FeedbackProvidersPreview = MidnightProviders<
  FeedbackCircuitIdV8,
  typeof FEEDBACK_PRIVATE_STATE_ID,
  FeedbackPrivateState
>;

/**
 * A provider set together with the cleanup its indexer connection needs —
 * tagged with the era it was built for. The tag is what lets the join/submit
 * flow keep the two eras' hands apart: building and using the providers
 * inside one era branch (as the official starter does) removes the
 * opportunity to pair a ledger-9 set with a ledger-8 contract.
 */
export type ProviderBundle =
  | { era: "v9"; providers: FeedbackProviders; dispose: () => Promise<void> }
  | { era: "v8-preview"; providers: FeedbackProvidersPreview; dispose: () => Promise<void> };

/**
 * Only the connector methods a provider set reaches for — narrowed so a test
 * need not stand up a whole connector.
 */
export type ProviderConnector = Pick<
  ConnectedAPI,
  | "getConfiguration"
  | "getShieldedAddresses"
  | "getUnshieldedAddress"
  | "balanceUnsealedTransaction"
  | "submitTransaction"
  | "getProvingProvider"
>;

/**
 * Builds the full provider set for the connected wallet, for the build-time
 * era (VITE_MIDNIGHT_ERA). Callers receive an era-tagged bundle; the flow
 * layer branches on `bundle.era` and passes `bundle.providers` only to the
 * SDK overloads of the matching era.
 *
 * @param options.networkId The network reported by the connected wallet;
 *   midnight-js internals read the global network id, so it is registered here.
 */
export async function buildProvidersFromConnectedAPI(
  connectedAPI: ProviderConnector,
  options: { networkId: string },
): Promise<ProviderBundle> {
  return ERA === "v8-preview"
    ? buildPreviewProviders(connectedAPI, options)
    : buildV9Providers(connectedAPI, options);
}

/** The v9 (current-era) arm: delegated proving with the ledger-v9 cost model. */
async function buildV9Providers(
  connectedAPI: ProviderConnector,
  options: { networkId: string },
): Promise<ProviderBundle & { era: "v9" }> {
  setNetworkId(options.networkId);

  const zkConfigHttpBase = `${window.location.origin}${ZK_HTTP_ROUTE}`;
  const zkConfigProvider = new FetchZkConfigProvider<FeedbackCircuitId>(
    zkConfigHttpBase,
    { fetchFunc: fetch.bind(window), verify: "require" },
  );

  const config = await connectedAPI.getConfiguration();
  const publicDataProvider = indexerPublicDataProvider({
    queryURL: config.indexerUri,
    subscriptionURL: config.indexerWsUri,
  });

  try {
    const { walletProvider, midnightProvider } = await (async () => {
      const shieldedAddress = await connectedAPI.getShieldedAddresses();
      const { unshieldedAddress } = await connectedAPI.getUnshieldedAddress();
      const { walletProvider, midnightProvider } =
        createWalletProvidersFromConnectedAPI(connectedAPI, {
          getCoinPublicKey: () => shieldedAddress.shieldedCoinPublicKey,
          getEncryptionPublicKey: () => shieldedAddress.shieldedEncryptionPublicKey,
        });
      return { walletProvider, midnightProvider, unshieldedAddress };
    })();

    const privateStateProvider = levelPrivateStateProvider<
      typeof FEEDBACK_PRIVATE_STATE_ID,
      FeedbackPrivateState
    >({
      privateStoragePasswordProvider: storagePassword,
      accountId: walletProvider.getCoinPublicKey(),
    });

    const proofProvider = await (async () => {
      if (typeof connectedAPI.getProvingProvider === "function") {
        // Era-specific values are imported inside the arm: the ledger-v9
        // runtime must stay out of a Preview build's module graph entirely.
        const [{ CostModel }, { dappConnectorProofProvider }] = await Promise.all([
          import("@midnightntwrk/ledger-v9"),
          import("@midnight-ntwrk/midnight-js-dapp-connector-proof-provider"),
        ]);
        return dappConnectorProofProvider(
          connectedAPI,
          zkConfigProvider,
          CostModel.initialCostModel(),
        );
      }
      if (config.proverServerUri) {
        return httpClientProofProvider({ url: config.proverServerUri, zkConfigProvider });
      }
      throw new Error(
        "No proving path available: the connected wallet offers neither delegated proving " +
          "(getProvingProvider) nor a proof server (proverServerUri). Update 1AM Wallet and reconnect.",
      );
    })();

    return {
      era: "v9",
      providers: {
        privateStateProvider,
        publicDataProvider,
        zkConfigProvider,
        proofProvider,
        walletProvider,
        midnightProvider,
      },
      dispose: () => publicDataProvider.dispose(),
    };
  } catch (error) {
    // The indexer owns a WebSocket and an Apollo client; a failed build must
    // not leak them. Release is reported, never rethrown — the error worth
    // surfacing is the one that explains why the set could not be built.
    await publicDataProvider.dispose().catch((disposeError: unknown) => {
      console.error("[providers] could not release the indexer after a failed build", disposeError);
    });
    throw error;
  }
}

/**
 * The Preview (retained ledger-v8) arm, following the official starter's
 * retained-era providers: proof server from the wallet's `proverServerUri`
 * and 'require-if-present' artifact integrity (compactc 0.31.1 emits no
 * contract-manifest.json).
 */
async function buildPreviewProviders(
  connectedAPI: ProviderConnector,
  options: { networkId: string },
): Promise<ProviderBundle & { era: "v8-preview" }> {
  setNetworkId(options.networkId);

  const zkConfigHttpBase = `${window.location.origin}${ZK_HTTP_ROUTE}`;
  const zkConfigProvider = new FetchZkConfigProvider<FeedbackCircuitIdV8>(
    zkConfigHttpBase,
    {
      fetchFunc: fetch.bind(window),
      verify: "require-if-present" satisfies ZkArtifactIntegrityMode,
    },
  );

  const config = await connectedAPI.getConfiguration();
  const publicDataProvider = indexerPublicDataProvider({
    queryURL: config.indexerUri,
    subscriptionURL: config.indexerWsUri,
  });

  try {
    const { walletProvider, midnightProvider } = await (async () => {
      const shieldedAddress = await connectedAPI.getShieldedAddresses();
      const { unshieldedAddress } = await connectedAPI.getUnshieldedAddress();
      const { walletProvider, midnightProvider } =
        createWalletProvidersFromConnectedAPI(connectedAPI, {
          getCoinPublicKey: () => shieldedAddress.shieldedCoinPublicKey,
          getEncryptionPublicKey: () => shieldedAddress.shieldedEncryptionPublicKey,
        });
      return { walletProvider, midnightProvider, unshieldedAddress };
    })();

    const privateStateProvider = levelPrivateStateProvider<
      typeof FEEDBACK_PRIVATE_STATE_ID,
      FeedbackPrivateState
    >({
      privateStoragePasswordProvider: storagePassword,
      accountId: walletProvider.getCoinPublicKey(),
    });

    if (!config.proverServerUri) {
      throw new Error(
        "The connected wallet did not supply a proof-server URL (proverServerUri). " +
          "Set the proof server in 1AM Wallet and reconnect — the Preview-era contract is " +
          "proved through the wallet's proof server, as in the official retained-era flow.",
      );
    }
    const proofProvider = httpClientProofProvider({
      url: config.proverServerUri,
      zkConfigProvider,
    });

    return {
      era: "v8-preview",
      providers: {
        privateStateProvider,
        publicDataProvider,
        zkConfigProvider,
        proofProvider,
        walletProvider,
        midnightProvider,
      },
      dispose: () => publicDataProvider.dispose(),
    };
  } catch (error) {
    await publicDataProvider.dispose().catch((disposeError: unknown) => {
      console.error("[providers] could not release the indexer after a failed build", disposeError);
    });
    throw error;
  }
}
