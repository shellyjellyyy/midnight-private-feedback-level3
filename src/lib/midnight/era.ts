/**
 * Deployment-era configuration — the single source of truth for which compiled
 * contract era this build binds to.
 *
 *   v9 (default)  — managed/feedback    (compactc 0.34.0 / runtime 0.19.0)
 *                   targets the future ledger-v9 fork on Preprod.
 *   v8-preview    — managed/feedback-v8 (compactc 0.31.1 / runtime 0.16.0)
 *                   targets the LIVE Preview network (still ledger-v8).
 *
 * Selected at BUILD time via VITE_MIDNIGHT_ERA ("v8-preview" | unset/"v9").
 * `npm run build:preview` builds the Preview-era bundle; the default build
 * remains v9. The demo UI must always name its era exactly (never claim that
 * Preview is v9) — render ERA_LABEL wherever the network is shown.
 */

export type MidnightEra = "v9" | "v8-preview";

export const ERA: MidnightEra =
  import.meta.env.VITE_MIDNIGHT_ERA === "v8-preview" ? "v8-preview" : "v9";

export const MANAGED_ARTIFACT_DIR = ERA === "v8-preview" ? "managed/feedback-v8" : "managed/feedback";

/** HTTP route (mounted by the Vite zk-assets plugin) serving the era's ZK keys. */
export const ZK_HTTP_ROUTE = `/contract/${MANAGED_ARTIFACT_DIR}`;

/** The Midnight network this era's live contract is deployed on. */
export const EXPECTED_NETWORK_ID = ERA === "v8-preview" ? "preview" : "preprod";

/**
 * The canonical Midnight Preview indexer endpoints.
 *
 * WHY THESE EXIST (the retained v8 Preview arm only)
 *   The DApp Connector API says a DApp should build its `publicDataProvider`
 *   from `getConfiguration()`, because the wallet user may prefer a particular
 *   indexer. 1AM Wallet on Preview supplies
 *   `https://api-preview.1am.xyz/api/v4/graphql` for `indexerUri` — which is
 *   its PROOF SERVER, not an indexer. 1AM's own developer page documents
 *   `proverServerUri: https://api-preview.1am.xyz` and, for Preview, an indexer
 *   of `indexer.preview.midnight.network`, so the wallet is populating the
 *   wrong field.
 *
 *   Measured against the deployed contract
 *   916ae63a…248bc with the installed Midnight.js RAW_CONTRACT_STATE_QUERY:
 *     api-preview.1am.xyz/api/v4/graphql        -> HTTP 401, no contract state
 *     indexer.preview.midnight.network/api/v4   -> HTTP 200, contract state present
 *   and the canonical WebSocket accepts `graphql-transport-ws` `connection_ack`
 *   while 1AM's refuses the handshake. The wallet's WebSocket URI is wrong the
 *   same way, which matters because `watchForTxData` subscribes over it.
 *
 *   So for the retained Preview era the public indexer endpoint is fixed to the
 *   canonical one. This is NOT a silent preference override: the wallet value is
 *   still read, still recorded (redacted) by the diagnostics, and the mismatch
 *   is still reported, so the wallet defect stays visible.
 *
 * SCOPE — deliberately narrow
 *   These constants are referenced ONLY by `buildPreviewProviders`, the
 *   retained ledger-v8 arm. The v9/preprod arm keeps using the wallet's
 *   configuration untouched, because the defect is specific to what 1AM
 *   returns on Preview. There is no `VITE_`-driven switch here: the endpoint is
 *   a property of the Preview network, not a build-time choice.
 */
export const PREVIEW_INDEXER_HTTP_URI = "https://indexer.preview.midnight.network/api/v4/graphql";
export const PREVIEW_INDEXER_WS_URI =
  "wss://indexer.preview.midnight.network/api/v4/graphql/ws";

/**
 * The canonical Midnight Preview proof server.
 *
 * WHY THIS EXISTS (the retained v8 Preview arm only)
 *   The retained-era proof provider is built from the connected wallet's
 *   `proverServerUri`. The connector type marks that field optional and
 *   deprecated ("likely to not be present"), and Lace — the fallback wallet —
 *   is documented not to expose delegated proving at all, so it may omit it.
 *
 *   When a wallet supplies no proof server we fall back to this canonical
 *   Preview endpoint. It is the SAME server the Node admin/provisioning flow
 *   already proves against on Preview, so this adds no new trust dependency
 *   and no new moving part: it is a constant for the Preview network, exactly
 *   like the two indexer constants above.
 *
 *   A wallet that DOES supply `proverServerUri` keeps using the wallet's own
 *   value — the fallback is only reached when the field is absent, so the
 *   working 1AM path is byte-for-byte unchanged.
 */
export const PREVIEW_PROOF_SERVER_URI = "https://proof-server.preview.midnight.network/";

/** Exact, era-honest label for display in the demo UI. */
export const ERA_LABEL =
  ERA === "v8-preview"
    ? "Midnight Preview — retained ledger-v8 era (compactc 0.31.1)"
    : "Midnight Preprod — current ledger-v9 era (compactc 0.34.0)";
