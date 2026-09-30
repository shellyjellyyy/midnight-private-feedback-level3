/**
 * Regression test: the retained ledger-8 runtime must be ONE module instance.
 *
 * THE DEFECT THIS PINS
 *   The retained-era compact runtime reached the bundle under two different
 *   module specifiers that both resolve to compact-runtime 0.16.0:
 *
 *     "compact-runtime-ledger8"                  (bare npm alias, pulled in
 *                                                  transitively by
 *                                                  midnight-js-protocol)
 *     "@midnight-ntwrk/compact-runtime-ledger8"  (scoped alias this project
 *                                                  declares, and the name the
 *                                                  generated v8 contract module
 *                                                  imports)
 *
 *   Two directories mean two module instances, so `ChargedState` and
 *   `StateValue` get two different class identities. TypeScript sees one type
 *   and stays quiet; at runtime every `instanceof` and every wasm-bindgen
 *   constructor downcast across the copies fails. That surfaced as
 *   `expected instance of _ChargedState`, thrown by `QueryContext`'s downcast
 *   in the generated module's `ledger()` helper
 *   (`managed/feedback-v8/contract/index.js:997-1000`).
 *
 *   `midnight-js-protocol`'s own `assertSharedLedger8Instance` does NOT catch
 *   this: it compares `onchain-runtime-v3` against the copy IT loaded, never
 *   against the copy the generated contract holds.
 *
 * WHY ONLY IDENTITY IS ASSERTED
 *   The failing operation is a reference-equality failure, so reference
 *   equality is what is pinned. Behavioural round-trips would need to
 *   construct a `StateValue`, which the WASM API forbids directly
 *   ("StateValue cannot be constructed directly through the WASM API"), and
 *   the downcast that actually threw happens inside a `QueryContext`
 *   constructor this test cannot reach without a full contract call.
 */
import { describe, expect, it } from "vitest";

/** The bare alias, exactly as midnight-js-protocol's engine imports it. */
const BARE = "compact-runtime-ledger8";
/** The scoped alias, exactly as the generated v8 contract module imports it. */
const SCOPED = "@midnight-ntwrk/compact-runtime-ledger8";

type Runtime = Record<string, unknown>;

describe("retained ledger-8 runtime is a single module instance", () => {
  it("resolves both specifiers to the SAME module namespace", async () => {
    const bare = (await import(/* @vite-ignore */ BARE)) as Runtime;
    const scoped = (await import(/* @vite-ignore */ SCOPED)) as Runtime;
    expect(bare).toBe(scoped);
  });

  it("gives StateValue and ChargedState one class identity, not two", async () => {
    const bare = (await import(/* @vite-ignore */ BARE)) as Runtime;
    const scoped = (await import(/* @vite-ignore */ SCOPED)) as Runtime;

    // These two are what the generated `ledger()` helper compares and
    // constructs with. Before the resolve alias they were distinct
    // constructors with the same name, which is precisely why the failure
    // surfaced as a confusing "expected instance of _ChargedState" rather
    // than anything mentioning a duplicate package.
    expect(bare.ChargedState).toBe(scoped.ChargedState);
    expect(bare.StateValue).toBe(scoped.StateValue);
  });

  it("exposes the three members the generated ledger() helper requires", async () => {
    const scoped = (await import(/* @vite-ignore */ SCOPED)) as Runtime;
    // index.js:997-1000 reads StateValue, branches on ChargedState, and
    // constructs QueryContext.
    expect(scoped.StateValue).toBeDefined();
    expect(scoped.ChargedState).toBeDefined();
    expect(scoped.QueryContext).toBeDefined();
  });
});
