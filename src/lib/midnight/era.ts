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

/** Exact, era-honest label for display in the demo UI. */
export const ERA_LABEL =
  ERA === "v8-preview"
    ? "Midnight Preview — retained ledger-v8 era (compactc 0.31.1)"
    : "Midnight Preprod — current ledger-v9 era (compactc 0.34.0)";
