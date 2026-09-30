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

/**
 * NOT ASSERTED HERE, AND WHY
 *
 * The second axis — `@midnight-ntwrk/onchain-runtime-v3` reached once through
 * `compact-runtime-ledger8` and once directly — produced
 * `Ledger8InstanceMismatchError` in the BROWSER bundle. It is reproducible
 * under Node too, but not through Vitest: Vitest resolves modules with Node
 * semantics and never runs Vite's dependency optimizer, and the duplication
 * itself is caused BY that optimizer (esbuild inlines a wasm-bindgen package
 * into a chunk per importer, so each copy instantiates its own WASM and gets
 * its own class identities). The `optimizeDeps.exclude` that removes it
 * applies to the browser build only.
 *
 * So this axis is verified where it actually occurs — in the page. Run in the
 * devtools console on the dev server:
 *
 *   Promise.all([
 *     import('/node_modules/compact-runtime-ledger8/index.js'),
 *     import('/node_modules/@midnight-ntwrk/onchain-runtime-v3/midnight_onchain_runtime_wasm.js'),
 *   ]).then(([g, o]) => ({
 *     chargedStateSame: g.ChargedState === o.ChargedState,
 *     stateValueSame: g.StateValue === o.StateValue,
 *     contractStateSame: g.ContractState === o.ContractState,
 *   }))
 *
 * All three must be true. A false there is the dual-instantiation returning.
 */
