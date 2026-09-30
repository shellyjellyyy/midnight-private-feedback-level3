import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectLaceWallet,
  connectOneAmWallet,
  connectWallet,
  findLaceWallet,
  findOneAmWallet,
  findWallet,
  listAvailableWallets,
  WALLET_LABELS,
} from "../src/lib/wallet";
import { EXPECTED_NETWORK_ID, PREVIEW_PROOF_SERVER_URI } from "../src/lib/midnight/era";

/**
 * Injects a wallet under `id`. `overrides` replaces any of the InitialAPI
 * fields, so a test can present Lace by its real `rdns`, by its display name,
 * or both.
 */
function inject(id: string, overrides: Record<string, unknown> = {}) {
  const base = {
    rdns: "com.example.wallet",
    name: "Example Wallet",
    icon: "data:image/png;base64,",
    apiVersion: "4.0.1",
    connect: vi.fn(),
  };
  (window as unknown as { midnight: Record<string, unknown> }).midnight = {
    ...(window as unknown as { midnight?: Record<string, unknown> }).midnight,
    [id]: { ...base, ...overrides },
  };
}

/** Lace as it actually identifies itself: rdns `io.lace.wallet`, name `lace`. */
function injectLace(connectImpl?: unknown) {
  inject("lace-key", {
    rdns: "io.lace.wallet",
    name: "lace",
    connect:
      connectImpl ??
      vi.fn().mockResolvedValue({
        getConfiguration: vi.fn().mockResolvedValue({
          networkId: EXPECTED_NETWORK_ID,
          // Lace does not expose delegated proving, so a realistic Lace config
          // omits proverServerUri entirely.
        }),
        getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: "mn_addr1lace" }),
      }),
  });
}

function injectOneAm() {
  inject("oneam-key", {
    rdns: "xyz.1am.wallet",
    name: "1AM Wallet",
    connect: vi.fn().mockResolvedValue({
      getConfiguration: vi.fn().mockResolvedValue({
        networkId: EXPECTED_NETWORK_ID,
        proverServerUri: "https://api-preview.1am.xyz",
      }),
      getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: "mn_addr1oneam" }),
    }),
  });
}

describe("Lace discovery", () => {
  beforeEach(() => {
    (window as unknown as { midnight?: unknown }).midnight = undefined;
  });

  afterEach(() => vi.restoreAllMocks());

  it("finds Lace by its documented rdns, whatever the injected key is", () => {
    inject("some-random-uuid", { rdns: "io.lace.wallet", name: "lace" });
    expect(findLaceWallet()?.rdns).toBe("io.lace.wallet");
  });

  it("falls back to the name when rdns is not populated", () => {
    inject("k", { rdns: undefined, name: "Lace" });
    expect(findLaceWallet()?.name).toBe("Lace");
  });

  it("never selects Lace as 1AM, and never selects 1AM as Lace", () => {
    injectLace();
    injectOneAm();
    expect(findOneAmWallet()?.name).toBe("1AM Wallet");
    expect(findLaceWallet()?.rdns).toBe("io.lace.wallet");
  });

  it("ignores a wallet that is neither 1AM nor Lace", () => {
    inject("other", { rdns: "com.ctrl.wallet", name: "Ctrl" });
    expect(findWallet("lace")).toBeNull();
    expect(findOneAmWallet()).toBeNull();
    expect(listAvailableWallets()).toEqual([]);
  });
});

describe("listAvailableWallets", () => {
  beforeEach(() => {
    (window as unknown as { midnight?: unknown }).midnight = undefined;
  });

  it("reports only 1AM when only 1AM is installed", () => {
    injectOneAm();
    expect(listAvailableWallets()).toEqual(["1am"]);
  });

  it("reports only Lace when only Lace is installed", () => {
    injectLace();
    expect(listAvailableWallets()).toEqual(["lace"]);
  });

  it("reports both when both are installed", () => {
    injectOneAm();
    injectLace();
    expect(listAvailableWallets().sort()).toEqual(["1am", "lace"]);
  });

  it("reports none when nothing is injected", () => {
    expect(listAvailableWallets()).toEqual([]);
  });
});

describe("connectLaceWallet", () => {
  beforeEach(() => {
    (window as unknown as { midnight?: unknown }).midnight = undefined;
  });

  afterEach(() => vi.restoreAllMocks());

  it("connects Lace and hands back the live ConnectedAPI for the submit path", async () => {
    injectLace();
    const result = await connectLaceWallet();

    expect(result.status).toBe("connected");
    if (result.status === "connected") {
      // The submission flow builds providers and submits through this handle.
      expect(result.api).toBeDefined();
      expect(result.address).toBe("mn_addr1lace");
      expect(result.walletKind).toBe("lace");
    }
  });

  it("connects on the app's configured network", async () => {
    const connect = vi.fn().mockResolvedValue({
      getConfiguration: vi.fn().mockResolvedValue({ networkId: EXPECTED_NETWORK_ID }),
      getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: "mn_addr1lace" }),
    });
    injectLace(connect);

    await connectLaceWallet();
    expect(connect).toHaveBeenCalledWith(EXPECTED_NETWORK_ID);
  });

  it("reports not-installed when Lace is absent, naming Lace", async () => {
    injectOneAm();
    const result = await connectLaceWallet();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("not-installed");
      expect(result.message).toContain(WALLET_LABELS.lace);
    }
  });

  it("rejects a Lace wallet sitting on the wrong network", async () => {
    injectLace(
      vi.fn().mockResolvedValue({
        getConfiguration: vi.fn().mockResolvedValue({ networkId: "mainnet" }),
        getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: "mn_addr1lace" }),
      }),
    );

    const result = await connectLaceWallet();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("wrong-network");
      expect(result.message).toContain(EXPECTED_NETWORK_ID);
    }
  });

  it("classifies a Lace rejection by the connector code, tagged with Lace", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    injectLace(
      vi.fn().mockRejectedValue({
        type: "DAppConnectorAPIError",
        code: "Rejected",
        reason: "Request failed",
        message: "Request failed",
      }),
    );

    const result = await connectLaceWallet();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("rejected");
      expect(result.message).toContain(WALLET_LABELS.lace);
    }
    expect(spy).toHaveBeenCalledWith(
      "[wallet] Lace connect failed",
      expect.objectContaining({ stage: "connect", code: "Rejected" }),
    );
  });
});

describe("the 1AM path is unchanged", () => {
  beforeEach(() => {
    (window as unknown as { midnight?: unknown }).midnight = undefined;
  });

  afterEach(() => vi.restoreAllMocks());

  it("still connects 1AM and reports it as the 1AM kind", async () => {
    injectOneAm();
    const result = await connectOneAmWallet();

    expect(result.status).toBe("connected");
    if (result.status === "connected") {
      expect(result.walletKind).toBe("1am");
      expect(result.address).toBe("mn_addr1oneam");
    }
  });

  it("connectWallet('1am') is equivalent to connectOneAmWallet()", async () => {
    injectOneAm();
    const viaKind = await connectWallet("1am");
    expect(viaKind.status).toBe("connected");
    if (viaKind.status === "connected") {
      expect(viaKind.walletKind).toBe("1am");
    }
  });

  it("keeps the 1AM console diagnostic tag", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    inject("oneam-key", {
      rdns: "xyz.1am.wallet",
      name: "1AM Wallet",
      connect: vi.fn().mockRejectedValue(new Error("nope")),
    });

    await connectOneAmWallet();
    expect(spy).toHaveBeenCalledWith(
      "[wallet] 1AM connect failed",
      expect.objectContaining({ stage: "connect" }),
    );
  });
});

describe("proof-server fallback for wallets without delegated proving", () => {
  it("pins a canonical Preview proof server for the retained v8 arm", () => {
    // The constant the provider builder falls back to. A wallet that supplies
    // its own proverServerUri still wins; this only covers the Lace case where
    // the field is absent.
    expect(PREVIEW_PROOF_SERVER_URI).toBe("https://proof-server.preview.midnight.network/");
  });
});
