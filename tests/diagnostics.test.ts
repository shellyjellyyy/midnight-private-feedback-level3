/**
 * Tests for the browser-vs-Node runtime diagnostics added while diagnosing
 *
 *   "No contract deployed at contract address '<addr>'"
 *
 * The diagnostic is what establishes whether the browser's wallet-supplied
 * indexer configuration matches the working Node configuration, so two things
 * are load-bearing and are asserted here:
 *
 *   1. It reports the values FAITHFULLY — a diagnostic that normalised,
 *      trimmed, defaulted or masked a value would hide the very difference it
 *      exists to surface.
 *   2. It leaks nothing — it records public endpoints, a public network id and
 *      a public contract address, and never a wallet address, key, secret,
 *      credential or state byte.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiVersionOf,
  clearDiagnosticsLog,
  describeAddress,
  diagnosticsLog,
  KNOWN_GOOD_PREVIEW,
  KNOWN_GOOD_PREVIEW_CONTRACT_ADDRESS,
  probeRawContractState,
  redactDeep,
  redactEndpoint,
  reportJoinInput,
  reportProviderConfig,
} from "../src/lib/midnight/diagnostics";

const CONTRACT_ADDRESS = KNOWN_GOOD_PREVIEW_CONTRACT_ADDRESS;

/** Captures the single structured object handed to console.info. */
function captureInfo() {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  return {
    spy,
    last: () => spy.mock.calls.at(-1)?.[1],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearDiagnosticsLog();
});

describe("apiVersionOf", () => {
  it("reads the API version out of the canonical Preview endpoints", () => {
    expect(apiVersionOf(KNOWN_GOOD_PREVIEW.indexerUri)).toBe("v4");
    expect(apiVersionOf(KNOWN_GOOD_PREVIEW.indexerWsUri)).toBe("v4");
  });

  it("distinguishes API versions, which decide the GraphQL field set", () => {
    // The v5 `contract(address:, offset:)` field this build issues does not
    // exist on other versions, so a wrong version is a distinct finding.
    expect(apiVersionOf("https://indexer.preview.midnight.network/api/v3/graphql")).toBe("v3");
    expect(apiVersionOf("https://indexer.preview.midnight.network/api/v5/graphql")).toBe("v5");
  });

  it("returns null rather than throwing for unusable input", () => {
    expect(apiVersionOf(undefined)).toBeNull();
    expect(apiVersionOf(null)).toBeNull();
    expect(apiVersionOf("")).toBeNull();
    expect(apiVersionOf("not a url")).toBeNull();
    // A parseable URL with no /v<N> segment is itself a finding.
    expect(apiVersionOf("https://example.test/api/graphql")).toBeNull();
  });
});

describe("describeAddress", () => {
  it("reports the exact 32-byte address as byte-for-byte match", () => {
    expect(describeAddress(CONTRACT_ADDRESS)).toEqual({
      value: CONTRACT_ADDRESS,
      length: 64,
      is64Hex: true,
      matchesKnownGood: true,
    });
  });

  it("does not mask a mutated address — a mismatch must stay visible", () => {
    // A truncation, a stray 0x, or a single flipped nibble are exactly the
    // kinds of defects the comparison must be able to see.
    const truncated = CONTRACT_ADDRESS.slice(0, 63);
    const shape = describeAddress(truncated);
    expect(shape.length).toBe(63);
    expect(shape.is64Hex).toBe(false);
    expect(shape.matchesKnownGood).toBe(false);
    expect(shape.value).toBe(truncated);

    const prefixed = describeAddress(`0x${CONTRACT_ADDRESS}`);
    expect(prefixed.is64Hex).toBe(false);
    expect(prefixed.matchesKnownGood).toBe(false);

    const flipped = describeAddress(`916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bd`);
    expect(flipped.is64Hex).toBe(true);
    expect(flipped.matchesKnownGood).toBe(false);
  });
});

describe("reportProviderConfig", () => {
  const base = {
    era: "v8-preview",
    builder: "buildPreviewProviders" as const,
    expectedNetworkId: "preview",
    requestedNetworkId: "preview",
    registeredNetworkId: "preview",
    walletConfigNetworkId: "preview",
    walletConfigKeys: ["indexerUri", "indexerWsUri", "proverServerUri"],
  };

  it("reports matching configuration and marks every comparison true", () => {
    const { spy, last } = captureInfo();
    reportProviderConfig({
      phase: "before-construction",
      ...base,
      indexerUri: KNOWN_GOOD_PREVIEW.indexerUri,
      indexerWsUri: KNOWN_GOOD_PREVIEW.indexerWsUri,
      passedToProvider: {
        queryURL: KNOWN_GOOD_PREVIEW.indexerUri,
        subscriptionURL: KNOWN_GOOD_PREVIEW.indexerWsUri,
      },
    });

    const report = last();
    expect(report.indexerUri).toBe(KNOWN_GOOD_PREVIEW.indexerUri);
    expect(report.indexerWsUri).toBe(KNOWN_GOOD_PREVIEW.indexerWsUri);
    expect(report.indexerApiVersion).toBe("v4");
    expect(report.indexerWsApiVersion).toBe("v4");
    expect(report.indexerMatchesKnownGood).toBe(true);
    expect(report.indexerWsMatchesKnownGood).toBe(true);
    expect(report.networkIdMatchesKnownGood).toBe(true);
    // The value is passed through verbatim — proving no transformation.
    expect(report.passedToProvider.queryURL).toBe(report.indexerUri);
    expect(report.passedToProvider.subscriptionURL).toBe(report.indexerWsUri);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a wallet configuration that differs from the working Node path", () => {
    const { last } = captureInfo();
    reportProviderConfig({
      phase: "after-construction",
      ...base,
      requestedNetworkId: "preprod",
      registeredNetworkId: "preprod",
      walletConfigNetworkId: "preprod",
      indexerUri: "https://indexer.preview.midnight.network/api/v3/graphql",
      indexerWsUri: "wss://indexer.preview.midnight.network/api/v3/graphql/ws",
      passedToProvider: {
        queryURL: "https://indexer.preview.midnight.network/api/v3/graphql",
        subscriptionURL: "wss://indexer.preview.midnight.network/api/v3/graphql/ws",
      },
    });

    const report = last();
    expect(report.indexerMatchesKnownGood).toBe(false);
    expect(report.indexerWsMatchesKnownGood).toBe(false);
    expect(report.networkIdMatchesKnownGood).toBe(false);
    // The version difference is reported explicitly: it changes the schema.
    expect(report.indexerApiVersion).toBe("v3");
  });

  it("records wallet config KEY NAMES only, never proverServerUri's value", () => {
    const { spy, last } = captureInfo();
    reportProviderConfig({
      phase: "before-construction",
      ...base,
      indexerUri: KNOWN_GOOD_PREVIEW.indexerUri,
      indexerWsUri: KNOWN_GOOD_PREVIEW.indexerWsUri,
      passedToProvider: {
        queryURL: KNOWN_GOOD_PREVIEW.indexerUri,
        subscriptionURL: KNOWN_GOOD_PREVIEW.indexerWsUri,
      },
    });

    const report = last();
    // The key's PRESENCE is reported...
    expect(report.walletConfigKeys).toContain("proverServerUri");
    // ...but the proof-server URL itself is never read, so it cannot be logged.
    const serialized = JSON.stringify(spy.mock.calls);
    expect(serialized).not.toContain("proverServerUri\":");
    expect(serialized).not.toContain("https://proof-server");
  });
});

describe("probeRawContractState", () => {
  it("reports a returned state by LENGTH only, never by content", async () => {
    const { spy, last } = captureInfo();
    const raw = new Uint8Array([1, 2, 3, 4]);
    const diagnostic = await probeRawContractState("v8-preview", CONTRACT_ADDRESS, async () => ({
      raw,
    }));

    expect(diagnostic.outcome).toBe("returned-state");
    expect(diagnostic.stateByteLength).toBe(4);
    expect(diagnostic.errorName).toBeNull();
    // The bytes themselves are not in the report, nor in the console line.
    expect(JSON.stringify(spy.mock.calls)).not.toContain("[1,2,3,4]");
  });

  it("reports a null read as returned-null rather than swallowing it", async () => {
    captureInfo();
    const diagnostic = await probeRawContractState("v8-preview", CONTRACT_ADDRESS, async () => null);
    expect(diagnostic.outcome).toBe("returned-null");
    expect(diagnostic.stateByteLength).toBeNull();
  });

  it("captures a thrown error's name and message instead of propagating it", async () => {
    const { last } = captureInfo();
    const diagnostic = await probeRawContractState("v8-preview", CONTRACT_ADDRESS, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(diagnostic.outcome).toBe("threw");
    expect(diagnostic.errorName).toBe("TypeError");
    expect(diagnostic.errorMessage).toBe("Failed to fetch");
    expect(last().outcome).toBe("threw");
  });

  it("reports the address it probed alongside the outcome", async () => {
    captureInfo();
    const diagnostic = await probeRawContractState("v8-preview", CONTRACT_ADDRESS, async () => null);
    expect(diagnostic.contractAddress).toEqual(describeAddress(CONTRACT_ADDRESS));
    expect(diagnostic.era).toBe("v8-preview");
  });
});

describe("reportJoinInput", () => {
  it("records the exact address handed to findDeployedContract, and the era branch", () => {
    const { last } = captureInfo();
    reportJoinInput({ era: "v8-preview", buildEra: "v8-preview", address: CONTRACT_ADDRESS });

    const report = last();
    expect(report.contractAddress).toEqual(describeAddress(CONTRACT_ADDRESS));
    // The provider bundle's era and the build-time era must agree; a mismatch
    // would mean a ledger-9 provider set paired with a ledger-8 contract.
    expect(report.era).toBe("v8-preview");
    expect(report.buildEra).toBe("v8-preview");
  });

  it("does not mask an address that differs from the deployed contract", () => {
    const { last } = captureInfo();
    const wrong = CONTRACT_ADDRESS.replace(/^916/, "917");
    reportJoinInput({ era: "v8-preview", buildEra: "v8-preview", address: wrong });
    expect(last().contractAddress.matchesKnownGood).toBe(false);
    expect(last().contractAddress.value).toBe(wrong);
  });
});

/**
 * 1AM Wallet supplies `indexerUri` with a `session_token` in the query string.
 * That is live connection material: it must not reach the console, the in-page
 * panel, a screenshot of the panel, or the git history.
 */
describe("redactEndpoint", () => {
  const SECRET = "s3cr3t-session-value-do-not-log";

  it("removes a session_token value while keeping the comparable endpoint", () => {
    const redacted = redactEndpoint(
      `https://api-preview.1am.xyz/api/v4/graphql?session_token=${SECRET}`,
    );
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("https://api-preview.1am.xyz/api/v4/graphql");
    // The parameter NAME is kept, so the diagnosis stays useful.
    expect(redacted).toContain("session_token=");
    expect(redacted).toContain("<redacted>");
  });

  it("removes EVERY query value, including parameter names it does not recognise", () => {
    // An unfamiliar parameter name is not evidence that its value is public.
    const redacted = redactEndpoint(
      `https://api-preview.1am.xyz/api/v4/graphql?something_unexpected=${SECRET}`,
    );
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("something_unexpected=");
  });

  it("removes every parameter when several are present", () => {
    const redacted = redactEndpoint(
      `wss://api-preview.1am.xyz/api/v4/graphql/ws?session_token=${SECRET}&api_key=${SECRET}&x=${SECRET}`,
    );
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("api_key=<redacted>");
    expect(redacted).toContain("x=<withheld>");
  });

  it("drops the fragment, which can also carry a token", () => {
    expect(redactEndpoint(`https://h.test/p?a=b#${SECRET}`)).not.toContain(SECRET);
  });

  it("leaves a clean public endpoint byte-identical apart from normalisation", () => {
    expect(redactEndpoint(KNOWN_GOOD_PREVIEW.indexerUri)).toBe(KNOWN_GOOD_PREVIEW.indexerUri);
    expect(redactEndpoint(KNOWN_GOOD_PREVIEW.indexerWsUri)).toBe(KNOWN_GOOD_PREVIEW.indexerWsUri);
  });

  it("never passes a non-string or unparseable value through verbatim", () => {
    expect(redactEndpoint(null)).toBeNull();
    expect(redactEndpoint(42)).toBe("<non-string: number>");
    expect(redactEndpoint(undefined)).toBe("<non-string: undefined>");
    // A non-URL string that still has a token tail keeps only the pre-`?` part.
    const odd = redactEndpoint(`not-a-url?session_token=${SECRET}`);
    expect(odd).not.toContain(SECRET);
  });

  it("keeps the comparison booleans meaningful for a tokenised endpoint", () => {
    // Redaction must not make a mismatching endpoint look like a match.
    const redacted = redactEndpoint(`https://api-preview.1am.xyz/api/v4/graphql?session_token=${SECRET}`);
    expect(redacted).not.toBe(KNOWN_GOOD_PREVIEW.indexerUri);
    expect(apiVersionOf(redacted)).toBe("v4");
  });
});

describe("redactDeep", () => {
  const SECRET = "s3cr3t-session-value-do-not-log";

  it("redacts endpoints nested in objects and arrays", () => {
    const result = redactDeep({
      indexerUri: `https://api-preview.1am.xyz/api/v4/graphql?session_token=${SECRET}`,
      passedToProvider: {
        queryURL: `https://api-preview.1am.xyz/api/v4/graphql?session_token=${SECRET}`,
        list: [`wss://api-preview.1am.xyz/api/v4/graphql/ws?session_token=${SECRET}`],
      },
      safeBoolean: true,
      safeNumber: 3,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // Non-endpoint values pass through untouched.
    expect((result as Record<string, unknown>).safeBoolean).toBe(true);
    expect((result as Record<string, unknown>).safeNumber).toBe(3);
  });

  it("bounds recursion so a cyclic-looking structure cannot run away", () => {
    let deep: Record<string, unknown> = { value: `https://h.test/?session_token=${SECRET}` };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redactDeep(deep))).not.toContain(SECRET);
  });
});

describe("diagnosticsLog redaction at the emit boundary", () => {
  const SECRET = "s3cr3t-session-value-do-not-log";

  it("keeps a wallet session_token out of the recorded log and the console", () => {
    const { spy } = captureInfo();
    reportProviderConfig({
      phase: "before-construction",
      era: "v8-preview",
      builder: "buildPreviewProviders",
      expectedNetworkId: "preview",
      requestedNetworkId: "preview",
      registeredNetworkId: "preview",
      walletConfigNetworkId: "preview",
      walletConfigKeys: ["indexerUri", "indexerWsUri", "proverServerUri"],
      indexerUri: `https://api-preview.1am.xyz/api/v4/graphql?session_token=${SECRET}`,
      indexerWsUri: `wss://api-preview.1am.xyz/api/v4/graphql/ws?session_token=${SECRET}`,
      passedToProvider: {
        queryURL: `https://api-preview.1am.xyz/api/v4/graphql?session_token=${SECRET}`,
        subscriptionURL: `wss://api-preview.1am.xyz/api/v4/graphql/ws?session_token=${SECRET}`,
      },
    });

    // Neither the recorded log NOR the console line may contain the secret.
    expect(JSON.stringify(diagnosticsLog())).not.toContain(SECRET);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    // The endpoint identity is still visible, so the comparison still works.
    expect(JSON.stringify(diagnosticsLog())).toContain("api-preview.1am.xyz");
  });
});

describe("diagnosticsLog", () => {
  const base = {
    era: "v8-preview",
    builder: "buildPreviewProviders" as const,
    expectedNetworkId: "preview",
    requestedNetworkId: "preview",
    registeredNetworkId: "preview",
    walletConfigNetworkId: "preview",
    walletConfigKeys: ["indexerUri", "indexerWsUri"],
  };

  /** Emits one provider-configuration entry through the public reporter. */
  function reportOnce() {
    reportProviderConfig({
      phase: "before-construction",
      ...base,
      indexerUri: KNOWN_GOOD_PREVIEW.indexerUri,
      indexerWsUri: KNOWN_GOOD_PREVIEW.indexerWsUri,
      passedToProvider: {
        queryURL: KNOWN_GOOD_PREVIEW.indexerUri,
        subscriptionURL: KNOWN_GOOD_PREVIEW.indexerWsUri,
      },
    });
  }

  it("records entries in emission order so a deployed build can be read", () => {
    captureInfo();
    expect(diagnosticsLog()).toHaveLength(0);

    reportJoinInput({ era: "v8-preview", buildEra: "v8-preview", address: CONTRACT_ADDRESS });
    reportOnce();

    const log = diagnosticsLog();
    expect(log.map((entry) => entry.label)).toEqual([
      "join input",
      "provider configuration",
    ]);
    // Both eras are capturable, which is what the browser-vs-Node comparison needs.
    expect(log[0].value.era).toBe("v8-preview");
    expect(log[1].value.indexerUri).toBe(KNOWN_GOOD_PREVIEW.indexerUri);
    expect(log[1].value.indexerApiVersion).toBe("v4");
  });

  it("clears on request", () => {
    captureInfo();
    reportOnce();
    expect(diagnosticsLog()).toHaveLength(1);
    clearDiagnosticsLog();
    expect(diagnosticsLog()).toHaveLength(0);
  });

  it("caps the log so a repeated submission cannot grow it without bound", () => {
    captureInfo();
    for (let i = 0; i < 60; i += 1) reportOnce();
    expect(diagnosticsLog().length).toBeLessThanOrEqual(40);
    // The newest entry survives the cap.
    expect(diagnosticsLog().at(-1)?.label).toBe("provider configuration");
  });
});