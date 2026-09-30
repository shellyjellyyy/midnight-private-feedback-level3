/**
 * Regression test for the retained v8 Preview indexer endpoint.
 *
 * THE DEFECT
 *   1AM Wallet on Preview reports
 *     indexerUri:   https://api-preview.1am.xyz/api/v4/graphql
 *     indexerWsUri: wss://api-preview.1am.xyz/api/v4/graphql/ws
 *   `api-preview.1am.xyz` is 1AM's PROOF SERVER (ProofStation) — its `/docs`
 *   serves "Proof Server API" and its GraphQL path answers HTTP 401
 *   "Authentication required" — not a Midnight indexer. 1AM's own developer
 *   page documents `proverServerUri: https://api-preview.1am.xyz` and, for
 *   Preview, an indexer of `indexer.preview.midnight.network`.
 *
 *   The DApp therefore built its `publicDataProvider` against a host that cannot
 *   serve public contract state, and `findDeployedContract()` failed with
 *   "No contract deployed at contract address '916ae63a…248bc'" for a contract
 *   that is deployed and readable.
 *
 * WHAT IS PINNED HERE
 *   `buildPreviewProviders()` must construct the indexer provider with the
 *   canonical Midnight Preview HTTP and WebSocket endpoints, regardless of what
 *   the wallet reports, WHILE every wallet-specific service — the proof server,
 *   balancing, signing and submission — still comes from `getConfiguration()`.
 *
 *   And the pinning must not leak: the v9/preprod arm still follows the wallet.
 *
 * NO NETWORK ACCESS. Every SDK provider is stubbed; the only thing observed is
 * the argument object each provider constructor was called with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 1AM's ProofStation — the value the live wallet actually reports. */
const WALLET_HTTP = "https://api-preview.1am.xyz/api/v4/graphql";
const WALLET_WS = "wss://api-preview.1am.xyz/api/v4/graphql/ws";
const WALLET_PROVER = "https://api-preview.1am.xyz";

/** The canonical Midnight Preview indexer. */
const CANONICAL_HTTP = "https://indexer.preview.midnight.network/api/v4/graphql";
const CANONICAL_WS = "wss://indexer.preview.midnight.network/api/v4/graphql/ws";

// Captured constructor arguments.
const indexerCalls: Array<Record<string, unknown>> = [];
const proofCalls: Array<Record<string, unknown>> = [];
const walletAdapterCalls: unknown[][] = [];

vi.mock("@midnight-ntwrk/midnight-js-indexer-public-data-provider", () => ({
  indexerPublicDataProvider: (config: Record<string, unknown>) => {
    indexerCalls.push(config);
    return { dispose: vi.fn(async () => {}) };
  },
}));
vi.mock("@midnight-ntwrk/midnight-js-http-client-proof-provider", () => ({
  httpClientProofProvider: (config: Record<string, unknown>) => {
    proofCalls.push(config);
    return {};
  },
}));
vi.mock("@midnight-ntwrk/midnight-js-fetch-zk-config-provider", () => ({
  FetchZkConfigProvider: class {
    constructor(...args: unknown[]) {
      void args;
    }
  },
}));
vi.mock("@midnight-ntwrk/midnight-js-level-private-state-provider", () => ({
  levelPrivateStateProvider: () => ({
    getCoinPublicKey: () => "coin-public-key",
    setContractAddress: vi.fn(),
  }),
}));
vi.mock("@midnight-ntwrk/midnight-js-network-id", () => ({
  setNetworkId: vi.fn(),
  getNetworkId: () => "preview",
}));
vi.mock("../src/lib/midnight/walletAdapter.js", () => ({
  createWalletProvidersFromConnectedAPI: (...args: unknown[]) => {
    walletAdapterCalls.push(args);
    return {
      walletProvider: { getCoinPublicKey: () => "coin-public-key" },
      midnightProvider: { submitTransaction: vi.fn() },
    };
  },
}));

// The app's build-time era. The Preview arm is the subject of this file.
vi.mock("../src/lib/midnight/era.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/midnight/era.js")>(
    "../src/lib/midnight/era.js",
  );
  return { ...actual, ERA: "v8-preview", EXPECTED_NETWORK_ID: "preview" };
});

const { buildProvidersFromConnectedAPI } = await import("../src/lib/midnight/providers.js");

/** A connected 1AM API reporting the ProofStation URLs, as it does live. */
function oneAmConnector() {
  return {
    getConfiguration: vi.fn().mockResolvedValue({
      networkId: "preview",
      indexerUri: WALLET_HTTP,
      indexerWsUri: WALLET_WS,
      proverServerUri: WALLET_PROVER,
      substrateNodeUri: "wss://rpc.preview.midnight.network",
    }),
    getShieldedAddresses: vi.fn().mockResolvedValue({
      shieldedCoinPublicKey: "coin-public-key",
      shieldedEncryptionPublicKey: "encryption-public-key",
    }),
    getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: "mn_addr1test" }),
    balanceUnsealedTransaction: vi.fn(),
    submitTransaction: vi.fn(),
    getProvingProvider: vi.fn(),
  } as never;
}

beforeEach(() => {
  indexerCalls.length = 0;
  proofCalls.length = 0;
  walletAdapterCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("retained v8 Preview indexer endpoint", () => {
  it("builds the publicDataProvider with the canonical Preview indexer, not the wallet's ProofStation", async () => {
    const bundle = await buildProvidersFromConnectedAPI(oneAmConnector(), { networkId: "preview" });

    expect(bundle.era).toBe("v8-preview");
    expect(indexerCalls).toHaveLength(1);
    expect(indexerCalls[0].queryURL).toBe(CANONICAL_HTTP);
    expect(indexerCalls[0].subscriptionURL).toBe(CANONICAL_WS);

    // Explicitly: the ProofStation must appear nowhere in the provider config.
    expect(JSON.stringify(indexerCalls[0])).not.toContain("1am.xyz");
  });

  it("keeps the proof server on the wallet's configuration", async () => {
    await buildProvidersFromConnectedAPI(oneAmConnector(), { networkId: "preview" });

    // The wallet's ProofStation is still what proves the transaction.
    expect(proofCalls).toHaveLength(1);
    expect(proofCalls[0].url).toBe(WALLET_PROVER);
  });

  it("still uses the connected wallet for balancing, signing and submission", async () => {
    const connector = oneAmConnector();
    await buildProvidersFromConnectedAPI(connector, { networkId: "preview" });

    // The adapter is handed the live ConnectedAPI, so walletProvider and
    // midnightProvider keep routing through the wallet.
    expect(walletAdapterCalls).toHaveLength(1);
    expect(walletAdapterCalls[0][0]).toBe(connector);
    // And the wallet is what supplied the configuration this arm read.
    expect((connector as unknown as { getConfiguration: { mock: { calls: unknown[] } } })
      .getConfiguration.mock.calls.length).toBeGreaterThan(0);
  });

  it("pins the endpoint even when the wallet reports a different ProofStation path", async () => {
    // A wallet pointing at another host, or at a session-tokenised variant,
    // must not be able to steer the Preview era's publicDataProvider.
    const connector = oneAmConnector();
    connector.getConfiguration = vi.fn().mockResolvedValue({
      networkId: "preview",
      indexerUri: `${WALLET_HTTP}?session_token=not-a-real-token`,
      indexerWsUri: `${WALLET_WS}?session_token=not-a-real-token`,
      proverServerUri: WALLET_PROVER,
      substrateNodeUri: "wss://rpc.preview.midnight.network",
    }) as never;

    await buildProvidersFromConnectedAPI(connector, { networkId: "preview" });

    expect(indexerCalls[0].queryURL).toBe(CANONICAL_HTTP);
    expect(indexerCalls[0].subscriptionURL).toBe(CANONICAL_WS);
    // No query string, and therefore no credential, is carried into the request.
    expect(String(indexerCalls[0].queryURL)).not.toContain("?");
    expect(String(indexerCalls[0].subscriptionURL)).not.toContain("?");
  });

  it("uses the wallet's indexer unchanged when it already agrees with the canonical one", async () => {
    const connector = oneAmConnector();
    connector.getConfiguration = vi.fn().mockResolvedValue({
      networkId: "preview",
      indexerUri: CANONICAL_HTTP,
      indexerWsUri: CANONICAL_WS,
      proverServerUri: WALLET_PROVER,
      substrateNodeUri: "wss://rpc.preview.midnight.network",
    }) as never;

    await buildProvidersFromConnectedAPI(connector, { networkId: "preview" });

    // Same result either way — pinning changes nothing when the wallet is right.
    expect(indexerCalls[0].queryURL).toBe(CANONICAL_HTTP);
    expect(indexerCalls[0].subscriptionURL).toBe(CANONICAL_WS);
  });

  it("still refuses when the wallet supplies no proof server", async () => {
    const connector = oneAmConnector();
    connector.getConfiguration = vi.fn().mockResolvedValue({
      networkId: "preview",
      indexerUri: WALLET_HTTP,
      indexerWsUri: WALLET_WS,
      proverServerUri: undefined,
    }) as never;

    await expect(
      buildProvidersFromConnectedAPI(connector, { networkId: "preview" }),
    ).rejects.toThrow(/proof-server URL/);
  });

  it("reports the mismatch in diagnostics without leaking the wallet's token", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { clearDiagnosticsLog, diagnosticsLog } = await import(
      "../src/lib/midnight/diagnostics.js"
    );
    clearDiagnosticsLog();

    const connector = oneAmConnector();
    connector.getConfiguration = vi.fn().mockResolvedValue({
      networkId: "preview",
      indexerUri: `${WALLET_HTTP}?session_token=SECRET_VALUE_MUST_NOT_LEAK`,
      indexerWsUri: `${WALLET_WS}?session_token=SECRET_VALUE_MUST_NOT_LEAK`,
      proverServerUri: WALLET_PROVER,
    }) as never;

    await buildProvidersFromConnectedAPI(connector, { networkId: "preview" });

    const serialized = JSON.stringify(diagnosticsLog());
    expect(serialized).not.toContain("SECRET_VALUE_MUST_NOT_LEAK");
    expect(JSON.stringify(info.mock.calls)).not.toContain("SECRET_VALUE_MUST_NOT_LEAK");

    // The wallet defect stays visible: source is the canonical endpoint, and
    // the wallet's own (redacted) value is still reported alongside it.
    const entry = diagnosticsLog().find((e) => e.label === "provider configuration");
    expect(entry?.value.indexerSource).toBe("canonical-preview");
    expect(String(entry?.value.indexerUri)).toContain("api-preview.1am.xyz");
    expect(String(entry?.value.passedToProvider.queryURL)).toBe(CANONICAL_HTTP);

    vi.restoreAllMocks();
  });
});