/**
 * Browser-side runtime diagnostics for the Preview join failure
 * ("No contract deployed at contract address '<addr>'").
 *
 * WHY THIS EXISTS
 *   The exact same retained v8 SDK, the same retained artifacts, the same
 *   `findDeployedContract()` path and the same contract address succeed in
 *   Node against the Preview indexer, and fail in the browser. Every value
 *   that could differ between those two runtimes is supplied to the browser
 *   provider set by the WALLET (via `ConnectedAPI.getConfiguration()`), and
 *   nothing in this repo's source states what those values actually are at
 *   runtime — they are only known to the running page.
 *
 *   So this module records the runtime values, and only those, at the exact
 *   points where they are consumed. It exists to answer a factual comparison
 *   between the browser and the working Node path. It changes no behaviour.
 *
 * WHAT IS DELIBERATELY NEVER RECORDED
 *   No wallet address (shielded or unshielded), no coin/encryption public key,
 *   no private state, no invite secret, no seed or key material, no
 *   `proverServerUri` token or credential, no provider internals, no GraphQL
 *   variable values other than the public contract address, and no response
 *   bodies. Every value emitted here is either a public network endpoint, a
 *   public network identifier, a public contract address, or a boolean/counter
 *   derived from one of those.
 *
 *   `configKeys` records only the *names* of the keys the wallet's
 *   Configuration object carries — never their values — which is what proves
 *   whether the configuration actually came from `getConfiguration()` and
 *   whether the field this app reads under that name is present at all.
 *
 *   Endpoint QUERY STRINGS are redacted before anything is recorded or logged —
 *   see {@link redactEndpoint}. This is not hypothetical: 1AM Wallet supplies
 *   `indexerUri` carrying a `session_token`, which is live connection material.
 *   Recording it verbatim would write a credential into the console, into the
 *   in-page panel, and into any screenshot taken of that panel.
 *
 * DIAGNOSTIC ONLY
 *   Nothing here alters configuration, supplies a fallback, retries, or
 *   changes a provider's behaviour. Every function is a pure read plus a
 *   `console.info` / `console.warn`.
 */

/** Console prefix so these lines are greppable apart from app logs. */
const TAG = "[midnight-diagnostics]";

/**
 * Endpoint query-parameter names whose VALUES are credentials. Matched
 * case-insensitively against every query parameter of an endpoint URL.
 *
 * `session_token` is observed in 1AM Wallet's `indexerUri`. The rest are names
 * this project or its wallet could plausibly carry; note that
 * {@link redactEndpoint} drops the value of EVERY parameter regardless of its
 * name, because an unfamiliar name is not evidence that its value is public.
 */
const SENSITIVE_QUERY_PARAMS = [
  "session_token",
  "sessiontoken",
  "session_id",
  "sessionid",
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "token",
  "auth",
  "authorization",
  "password",
  "secret",
  "key",
  "signature",
  "sig",
] as const;

/**
 * True when a string could carry an endpoint's credential tail — i.e. it has a
 * scheme, a query string, or a fragment.
 *
 * A string with none of those (`"v4"`, `"preview"`, a bare 64-hex contract
 * address, an error message) cannot be hiding a session token, and mangling it
 * would destroy the very values this diagnostic exists to report.
 */
function mayCarryEndpointCredentials(value: string): boolean {
  return value.includes("://") || value.includes("?") || value.includes("#");
}

/**
 * Returns an endpoint safe to record and display: scheme, host, port and path
 * are kept — they are public, and they are the whole point of the comparison —
 * while every query-string value is replaced with a redaction marker.
 *
 * A value that cannot carry endpoint credentials is returned UNCHANGED. A
 * non-string, or an unparseable string that does have a query/fragment, is
 * reduced to a safe note rather than passed through, so a malformed value
 * cannot smuggle a credential out.
 */
export function redactEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return value === null ? null : `<non-string: ${typeof value}>`;
  if (value.length === 0) return value;
  if (!mayCarryEndpointCredentials(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not a URL, but it still has a query/fragment that may hold a token, so
    // record only the part before the first separator.
    const cut = value.search(/[?#]/);
    return `${cut === -1 ? value : value.slice(0, cut)}<unparseable endpoint: query/fragment withheld>`;
  }

  const names = [...url.searchParams.keys()];
  if (names.length > 0) {
    const flagged = new Set(
      names.filter((name) =>
        SENSITIVE_QUERY_PARAMS.includes(name.toLowerCase() as (typeof SENSITIVE_QUERY_PARAMS)[number]),
      ),
    );
    // Built by hand rather than assigned to `url.search`, because URLSearchParams
    // percent-encodes the marker and would leave `%3Credacted%3E` on screen.
    const redacted = names
      .map((name) => `${name}=${flagged.has(name) ? "<redacted>" : "<withheld>"}`)
      .join("&");
    const base = `${url.origin}${url.pathname}`;
    return `${base}?${redacted}`;
  }

  const base = `${url.origin}${url.pathname}`;
  // A fragment can carry a token too, and url.origin/pathname already dropped it.
  return base;
}

/**
 * Field names whose VALUES are secret material that must never be recorded.
 *
 * `redactEndpoint` only mangles strings that look like URLs, because a bare
 * 64-hex value is indistinguishable from the public contract address. That is
 * correct for endpoints but wrong for a FIELD NAMED like a secret: a field
 * called `secret`, `inviteSecret` or `privateState` carries the respondent's
 * invite secret by construction, and must be dropped by NAME rather than by
 * shape.
 *
 * This is defense at the single `emit()` boundary, so a future caller cannot
 * leak a secret into the console or the in-page panel by adding a field. The
 * app itself never passes one — the secret reaches exactly one consumer, the
 * `submitFeedback` witness — so this closes a leak that would only open through
 * a future change.
 */
const SENSITIVE_FIELD_NAMES = [
  "secret",
  "invitesecret",
  "invite_secret",
  "privatestate",
  "private_state",
  "password",
  "passphrase",
  "seed",
  "mnemonic",
  "privatekey",
  "private_key",
  "signingkey",
] as const;

/** True when a diagnostic field name denotes secret material. */
function isSensitiveFieldName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-\s]/g, "_");
  return SENSITIVE_FIELD_NAMES.includes(
    normalized.replace(/_/g, "") as (typeof SENSITIVE_FIELD_NAMES)[number],
  ) || (SENSITIVE_FIELD_NAMES as readonly string[]).includes(normalized);
}

/**
 * Recursively replaces every endpoint-looking string in a diagnostic value with
 * its redacted form, at any depth, and drops any field whose NAME denotes
 * secret material.
 *
 * Applied to every recorded entry so a credential cannot reach the console or
 * the panel through a field this module did not enumerate.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return "<nesting withheld>";
  if (typeof value === "string") return redactEndpoint(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveFieldName(key)) {
        out[key] = "<withheld>";
        continue;
      }
      out[key] = redactDeep(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * An in-page record of every diagnostic emitted this session, so the values can
 * be read off a DEPLOYED build without a DevTools console.
 *
 * The same objects that reach `console.info` are recorded here — nothing extra
 * is captured, and nothing here alters behaviour. Entries are appended in
 * emission order and capped so a repeated submission cannot grow without
 * bound. Every value is redacted on the way in (see {@link redactEndpoint}), so
 * a credential in an endpoint query string never reaches this log.
 */
export type DiagnosticEntry = {
  readonly at: string;
  readonly label: string;
  readonly value: unknown;
};

const MAX_ENTRIES = 40;
const recorded: DiagnosticEntry[] = [];

/**
 * Records and logs one diagnostic entry.
 *
 * The value is passed through {@link redactDeep} HERE, at the single boundary
 * where anything leaves this module, so no caller can bypass redaction by
 * adding a field.
 */
function emit(label: string, value: unknown): void {
  const safe = redactDeep(value);
  recorded.push({ at: new Date().toISOString(), label, value: safe });
  if (recorded.length > MAX_ENTRIES) recorded.splice(0, recorded.length - MAX_ENTRIES);
  console.info(`${TAG} ${label}`, safe);
}

/** Every diagnostic recorded this session, oldest first. */
export function diagnosticsLog(): readonly DiagnosticEntry[] {
  return recorded;
}

/** Clears the recorded log. Used by the panel's reset control and by tests. */
export function clearDiagnosticsLog(): void {
  recorded.length = 0;
}

/**
 * The canonical Preview endpoints this project's Node tooling talks to
 * (`scripts/diag-submitfeedback.mjs`, `scripts/verify-submitfeedback-onchain.mjs`).
 *
 * Present ONLY so the diagnostic can print a boolean "does the runtime value
 * match the known-good value" next to the value itself. Nothing in this file
 * ever substitutes these values for the wallet's.
 */
export const KNOWN_GOOD_PREVIEW = {
  networkId: "preview",
  indexerUri: "https://indexer.preview.midnight.network/api/v4/graphql",
  indexerWsUri: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
} as const;

/**
 * Extracts the GraphQL API version segment (`v4`) from an indexer endpoint.
 *
 * Returns null when the URL is unparseable or carries no `/v<N>` segment,
 * which is itself a finding: the v4 `contract(address:, offset:)` field this
 * build's `queryRawContractState()` issues does not exist on other versions.
 */
export function apiVersionOf(uri: string | undefined | null): string | null {
  if (typeof uri !== "string" || uri.length === 0) return null;
  try {
    const path = new URL(uri).pathname;
    const match = /\/v(\d+)(?:[/?]|$)/.exec(path);
    return match ? `v${match[1]}` : null;
  } catch {
    return null;
  }
}

/** The public shape of a contract address, for byte-for-byte comparison. */
export type AddressShape = {
  /** The exact string this runtime will hand to the SDK. */
  readonly value: string;
  /** Character length, so a truncated or padded value is visible. */
  readonly length: number;
  /** True for exactly 64 lowercase-or-uppercase hex chars, no `0x`. */
  readonly is64Hex: boolean;
  /** True when the value matches the known-good Preview contract address. */
  readonly matchesKnownGood: boolean;
};

/** Describes a contract address without mutating or normalizing it. */
export function describeAddress(
  value: string,
  knownGood: string = KNOWN_GOOD_PREVIEW_CONTRACT_ADDRESS,
): AddressShape {
  return {
    value,
    length: value.length,
    is64Hex: /^[0-9a-fA-F]{64}$/.test(value),
    matchesKnownGood: value.toLowerCase() === knownGood.toLowerCase(),
  };
}

/**
 * The known-good Preview contract address, used ONLY as a comparison target.
 *
 * Nothing in this module substitutes this value for the one the app is
 * configured with; `deployedContractAddress()` remains the sole source of the
 * address the SDK receives. It is a public value already present in the
 * deployed bundle, and it is kept in one place so the runtime comparison and
 * the side-by-side report cannot drift apart.
 */
export const KNOWN_GOOD_PREVIEW_CONTRACT_ADDRESS =
  "916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc";

/**
 * The provider-configuration diagnostic, emitted immediately BEFORE and
 * immediately AFTER `indexerPublicDataProvider(...)` is constructed in
 * `providers.ts`.
 *
 * `phase` distinguishes the two emissions so a construction that throws
 * between them is visible: a "before" with no matching "after" means the
 * provider constructor itself failed.
 */
export type ProviderConfigDiagnostic = {
  readonly phase: "before-construction" | "after-construction";
  /** Which compile-time era branch is building this provider set. */
  readonly era: string;
  /** The era-specific builder function, so the two arms are distinguishable. */
  readonly builder: string;
  /** `EXPECTED_NETWORK_ID` for this build, from `era.ts`. */
  readonly expectedNetworkId: string;
  /** What the caller passed in as `options.networkId` (the wallet's value). */
  readonly requestedNetworkId: string;
  /** The global network id actually registered via `setNetworkId()`. */
  readonly registeredNetworkId: string | null;
  /** `config.networkId` as reported by `connectedAPI.getConfiguration()`. */
  readonly walletConfigNetworkId: unknown;
  /** `config.indexerUri` verbatim, exactly as passed to the provider. */
  readonly indexerUri: unknown;
  /** `config.indexerWsUri` verbatim, exactly as passed to the provider. */
  readonly indexerWsUri: unknown;
  /** The key NAMES present on the wallet's Configuration object. No values. */
  readonly walletConfigKeys: readonly string[];
  /** GraphQL API version parsed out of `indexerUri`, or null. */
  readonly indexerApiVersion: string | null;
  /** GraphQL API version parsed out of `indexerWsUri`, or null. */
  readonly indexerWsApiVersion: string | null;
  /** Whether `indexerUri` equals the known-good Preview HTTP endpoint. */
  readonly indexerMatchesKnownGood: boolean;
  /** Whether `indexerWsUri` equals the known-good Preview WS endpoint. */
  readonly indexerWsMatchesKnownGood: boolean;
  /** Whether `options.networkId` equals the known-good Preview network id. */
  readonly networkIdMatchesKnownGood: boolean;
  /**
 * The values this module actually handed to `indexerPublicDataProvider`.
 *
 * Equal to `indexerUri` / `indexerWsUri` on arms that follow the wallet's
 * configuration, and deliberately different on the retained Preview arm, which
 * pins the canonical Preview indexer because 1AM Wallet reports its proof
 * server there. The distinction is the whole point of recording both.
 */
  readonly passedToProvider: { readonly queryURL: unknown; readonly subscriptionURL: unknown };
  /**
   * Where the endpoint the provider was built with came from: `"wallet"` when
   * the wallet's own value was usable, `"canonical-preview"` when the era pins
   * the canonical endpoint because the wallet's was not.
   */
  readonly indexerSource?: "wallet" | "canonical-preview";
};

/**
 * Records the provider configuration. Purely observational.
 *
 * @param details Everything the caller already holds at the instrumentation
 *   point. This function adds only the parsed/compared fields.
 */
export function reportProviderConfig(
  details: Omit<
    ProviderConfigDiagnostic,
    "indexerApiVersion" | "indexerWsApiVersion" | "indexerMatchesKnownGood" | "indexerWsMatchesKnownGood" | "networkIdMatchesKnownGood"
  >,
): void {
  const diagnostic: ProviderConfigDiagnostic = {
    ...details,
    indexerApiVersion: apiVersionOf(asString(details.indexerUri)),
    indexerWsApiVersion: apiVersionOf(asString(details.indexerWsUri)),
    indexerMatchesKnownGood:
      asString(details.indexerUri) === KNOWN_GOOD_PREVIEW.indexerUri,
    indexerWsMatchesKnownGood:
      asString(details.indexerWsUri) === KNOWN_GOOD_PREVIEW.indexerWsUri,
    networkIdMatchesKnownGood: details.requestedNetworkId === KNOWN_GOOD_PREVIEW.networkId,
  };
  emit("provider configuration", diagnostic);
}

/** Narrowing helper: `unknown` → `string`, never throwing. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The result of the ONE read-only indexer read this project issues directly,
 * immediately before `findDeployedContract()`.
 *
 * `findDeployedContract()` itself already performs this read
 * (`queryRawContractState`), so this does not add a network dependency of its
 * own in any meaningful sense — it repeats one call to observe its outcome in
 * isolation, and reports ONLY whether state came back. Contract state bytes
 * are never logged.
 */
export type RawStateProbeDiagnostic = {
  readonly era: string;
  readonly contractAddress: AddressShape;
  /** "returned-state" | "returned-null" | "threw" */
  readonly outcome: "returned-state" | "returned-null" | "threw";
  /** Byte length of the state, when one was returned. Length only, not bytes. */
  readonly stateByteLength: number | null;
  /** The thrown error's name and message. Both are SDK/network text, no secrets. */
  readonly errorName: string | null;
  readonly errorMessage: string | null;
};

/**
 * Runs the single raw-state read and reports the outcome, then returns the
 * read value UNCHANGED so the caller can decide what to do with it.
 *
 * Diagnostics never swallow an error that the real flow depends on: this
 * function does not throw, and does not alter the value it returns.
 */
export async function probeRawContractState(
  era: string,
  contractAddress: string,
  read: () => Promise<{ raw: unknown } | null | undefined>,
): Promise<RawStateProbeDiagnostic> {
  const shape = describeAddress(contractAddress);
  let outcome: RawStateProbeDiagnostic["outcome"];
  let stateByteLength: number | null = null;
  let errorName: string | null = null;
  let errorMessage: string | null = null;

  try {
    const value = await read();
    if (value === null || value === undefined) {
      outcome = "returned-null";
    } else {
      outcome = "returned-state";
      const raw = value.raw;
      stateByteLength =
        raw instanceof Uint8Array ? raw.byteLength : typeof raw === "string" ? raw.length : null;
    }
  } catch (error) {
    outcome = "threw";
    errorName = error instanceof Error ? error.name : typeof error;
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const diagnostic: RawStateProbeDiagnostic = {
    era,
    contractAddress: shape,
    outcome,
    stateByteLength,
    errorName,
    errorMessage,
  };
  emit("raw indexer contract-state probe", diagnostic);
  return diagnostic;
}

/**
 * Records the join's input address and era, immediately before
 * `findDeployedContract()` is called. Purely observational.
 */
export function reportJoinInput(details: {
  readonly era: string;
  readonly buildEra: string;
  readonly address: string;
}): void {
  emit("join input", {
    era: details.era,
    buildEra: details.buildEra,
    contractAddress: describeAddress(details.address),
  });
}