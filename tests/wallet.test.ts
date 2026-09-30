import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectOneAmWallet, findOneAmWallet, shortenAddress } from "../src/lib/wallet";
import { EXPECTED_NETWORK_ID } from "../src/lib/midnight/era";

function installWallet(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    name: "1AM Wallet",
    icon: "data:image/png;base64,",
    apiVersion: "4.0.1",
    connect: vi.fn(),
  };
  (window as unknown as { midnight: Record<string, unknown> }).midnight = {
    ...(window as unknown as { midnight?: Record<string, unknown> }).midnight,
    [id]: { ...base, ...overrides },
  };
}

describe("1AM Wallet discovery", () => {
  beforeEach(() => {
    (window as unknown as { midnight?: unknown }).midnight = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no wallet is injected", () => {
    expect(findOneAmWallet()).toBeNull();
  });

  it("finds 1AM by name regardless of its injected key", () => {
    installWallet("some-random-uuid-1234");
    const found = findOneAmWallet();
    expect(found).not.toBeNull();
    expect(found?.name).toBe("1AM Wallet");
  });

  it("never selects Lace, even if it is the only wallet installed", () => {
    installWallet("lace-key", { name: "Lace" });
    expect(findOneAmWallet()).toBeNull();
  });

  it("selects 1AM specifically when both Lace and 1AM are installed", () => {
    installWallet("lace-key", { name: "Lace" });
    installWallet("oneam-key", { name: "1AM Wallet" });
    expect(findOneAmWallet()?.name).toBe("1AM Wallet");
  });
});

describe("connectOneAmWallet", () => {
  beforeEach(() => {
    (window as unknown as { midnight?: unknown }).midnight = undefined;
  });

  it("reports not-installed when 1AM is absent", async () => {
    const result = await connectOneAmWallet();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("not-installed");
    }
  });

  it("reports connected with the wallet's address on success", async () => {
    installWallet("oneam-key", {
      connect: vi.fn().mockResolvedValue({
        getConfiguration: vi.fn().mockResolvedValue({ networkId: "preprod" }),
        // v4 connector shape: getUnshieldedAddress resolves an OBJECT.
        getUnshieldedAddress: vi.fn().mockResolvedValue({
          unshieldedAddress: "mn_addr1exampleaddress0000000000000000000000",
        }),
      }),
    });

    const result = await connectOneAmWallet();
    expect(result.status).toBe("connected");
    if (result.status === "connected") {
      expect(result.address).toContain("mn_addr1");
      expect(result.networkId).toBe("preprod");
    }
  });

  it("reports wrong-network when the wallet is on a different network", async () => {
    installWallet("oneam-key", {
      connect: vi.fn().mockResolvedValue({
        getConfiguration: vi.fn().mockResolvedValue({ networkId: "mainnet" }),
        getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: "mn_addr1..." }),
      }),
    });

    const result = await connectOneAmWallet();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("wrong-network");
    }
  });

  it("reports rejected when the user declines the connection prompt", async () => {
    installWallet("oneam-key", {
      connect: vi.fn().mockRejectedValue(new Error("User rejected the request")),
    });

    const result = await connectOneAmWallet();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("rejected");
    }
  });

  it("falls back to a generic connection-failed error for unrecognized failures", async () => {
    installWallet("oneam-key", {
      connect: vi.fn().mockRejectedValue(new Error("timeout talking to extension")),
    });

    const result = await connectOneAmWallet();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("connection-failed");
    }
  });

  // The structured APIError fields are the authoritative signal: the connector
  // is a separate realm, so `code` is present even when `message` is opaque.
  it("classifies by the connector error code, not the message text", async () => {
    const cases: Array<[string, string]> = [
      ["PermissionRejected", "permission-rejected"],
      ["Rejected", "rejected"],
      ["InvalidRequest", "rejected"],
      ["Disconnected", "disconnected"],
      ["InternalError", "connection-failed"],
    ];

    for (const [code, expected] of cases) {
      installWallet("oneam-key", {
        connect: vi.fn().mockRejectedValue({
          type: "DAppConnectorAPIError",
          code,
          reason: "Request failed",
          message: "Request failed",
        }),
      });

      const result = await connectOneAmWallet();
      expect(result.status, `code ${code}`).toBe("error");
      if (result.status === "error") {
        expect(result.reason, `code ${code}`).toBe(expected);
        // The wallet's own reason is surfaced instead of being discarded.
        expect(result.message, `code ${code}`).toContain("Request failed");
      }
    }
  });

  it("does not mistake InternalError for a user rejection", async () => {
    // The real observed failure from the deployed site: an opaque message that
    // matches none of the rejection keywords, which the previous
    // substring-only check reported as a bare "please try again".
    installWallet("oneam-key", {
      connect: vi.fn().mockRejectedValue({
        type: "DAppConnectorAPIError",
        code: "InternalError",
        reason: "Request failed",
        message: "Request failed",
        name: "Error",
      }),
    });

    const result = await connectOneAmWallet();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("connection-failed");
      expect(result.message).toContain("Request failed");
    }
  });

  it("preserves the original error on the console for diagnosis", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = {
      type: "DAppConnectorAPIError",
      code: "InternalError",
      reason: "Request failed",
      message: "Request failed",
    };
    installWallet("oneam-key", { connect: vi.fn().mockRejectedValue(failure) });

    await connectOneAmWallet();

    expect(spy).toHaveBeenCalledWith(
      "[wallet] 1AM connect failed",
      expect.objectContaining({ stage: "connect", code: "InternalError", reason: "Request failed", error: failure }),
    );
  });

  it("reports the failing stage when a later connector call fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    installWallet("oneam-key", {
      connect: vi.fn().mockResolvedValue({
        // Echo the network the app actually asks for, so the check passes and
        // the address call is genuinely reached.
        getConfiguration: vi.fn().mockResolvedValue({ networkId: EXPECTED_NETWORK_ID }),
        getUnshieldedAddress: vi.fn().mockRejectedValue(new Error("boom")),
      }),
    });

    const result = await connectOneAmWallet();
    expect(result.status).toBe("error");
    expect(spy).toHaveBeenCalledWith(
      "[wallet] 1AM connect failed",
      expect.objectContaining({ stage: "getUnshieldedAddress" }),
    );
  });
});

describe("shortenAddress", () => {
  it("shortens long addresses for display", () => {
    const long = "mn_addr1abcdefghijklmnopqrstuvwxyz0123456789";
    const short = shortenAddress(long);
    expect(short.length).toBeLessThan(long.length);
    expect(short).toContain("...");
  });

  it("leaves short strings untouched", () => {
    expect(shortenAddress("short")).toBe("short");
  });
});
