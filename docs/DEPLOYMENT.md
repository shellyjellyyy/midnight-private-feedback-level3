# Preprod Deployment Runbook — midnight-private-feedback

Status as of **2026-09-25**: deployment is **blocked by an empirical, verifiable
chain-era fact**, not by project code. Everything below is reproducible.

## TL;DR blocker

| Question | Verified answer |
|---|---|
| Can the contract compile with full ZK? | **Yes** — done (compact +0.34.0, 17 artifacts, integrity-manifested). |
| Are Preprod services reachable? | **Yes** — indexer v4 GraphQL, node RPC, public proof server all answer. |
| Can a Node wallet be provisioned headlessly? | **Yes** — testkit-js 5.0.0-beta.8 built real Preprod wallets (addresses printed, seeds redacted). |
| Does the faucet fund automatically? | **No** — public faucet requires a browser captcha (HTTP 403 for automated drips). Human step. |
| Is Preprod on ledger-v9? | **NO — protocolVersion 1000300 at height ~2,694,7xx (threshold: 2,000,000). The chain is still pre-fork (ledger-v8).** |
| Can this project's contract be deployed right now? | **Not on Preprod** — the v9 artifact needs the fork. RESOLVED for the live chain: the SAME unmodified source was additionally compiled with the retained toolchain (compactc 0.31.1 / runtime 0.16.0) into `managed/feedback-v8`, and `scripts/deploy-preview.mjs` deploys it to **Preview** (still ledger-v8) with real transactions — the official retained-era dual-build pattern. |

The blocker is external (Midnight's Preprod fork schedule). When Preprod's
`protocolVersion` reaches 2,000,000, phase 2 of the deployment script runs as
written — no code changes are needed.

## Where the evidence comes from

```bash
# Chain tip + era (the load-bearing check):
curl -sS -X POST https://indexer.preprod.midnight.network/api/v4/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ block { height hash protocolVersion } }"}'
# => {"data":{"block":{"height":2694789,"hash":"2f48…","protocolVersion":1000300}}}

# The v9 fork threshold, from the SDK line this project uses:
#   node_modules/@midnightntwrk/wallet-sdk → DefaultForkSchedule = { v9: "2000000" }
# Cross-check (tip protocol version as reported by chain events):
#   zswapLedgerEvents stream shows protocolVersion 1000300 / 22000 frames.

# Faucet captcha (automated drips):
node -e "fetch('https://faucet.preprod.midnight.network/api/drips',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({recipientAddress:'x',amount:'1000'})}).then(r=>r.text()).then(console.log)"
# => {"error":"Missing X-Captcha-Token header"}; with the SDK's dummy token:
#    {"error":"Captcha verification failed"} (403)
```

## What the deployment flow does (all real, nothing simulated)

Two phases over the same deterministic seeds. The seed is read from the
environment only and is never written to disk, logs, or reports; a redacting
logger scrubs every SDK log line.

```bash
# 0. One-time environment fix (idempotent, self-verifying):
node scripts/patch-wallet-sdk-preprod.mjs
# beta.3's wallet-sdk was authored against an older Preprod indexer schema;
# this patches the 3 wire/schema drifts it has vs today's live indexer.

# 1. Phase 1 — provision both wallets, print fundable addresses:
MIDNIGHT_PREPROD_SEED=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  node scripts/deploy.mjs --fund-status
# Fund BOTH printed addresses with test NIGHT via the faucet web app
# (https://faucet.preprod.midnight.network — captcha is the human step).
# DUST then accrues automatically once NIGHT UTXOs are registered.

# 2. Phase 2 — the real thing:
MIDNIGHT_PREPROD_SEED=<same seed> node scripts/deploy.mjs
```

Phase 2 performs, in order (each step fails loudly if it cannot complete):

1. Preflight: indexer/node/proof-server reachability, chain-era read,
   ZK artifact presence (17 files, manifest-verified at use time).
2. **Chain-era gate**: refuses to run while `protocolVersion < 2000000`
   (exit 6). This is the gate that currently fires.
3. Funding check for both wallets (NIGHT > 0 and DUST > 0), with faucet
   retries; an unfunded wallet is a blocker, never a simulated success.
4. Admin secret: fresh `crypto.randomBytes(32)`, persisted only to the
   gitignored `.admin-secret` (or `MIDNIGHT_ADMIN_SECRET_FILE`). Only
   `adminIdentity(secret)` goes into the constructor — the raw secret never
   touches the chain, logs, or the report.
5. Real `deployContract` with `args: [adminIdentity]` (beta.8 API; prover =
   the public Preprod proof server; ZK integrity `require` mode).
6. Verification: contract state read back from the indexer; on-chain
   `adminAddress` compared to the derived identity; `findDeployedContract`
   attach (byte-matches local verifier keys against deployed keys).
7. Registration of 2 participants via real admin transactions
   (`registerParticipant(leaf)`), each gated on `SucceedEntirely` +
   all-segments-successful before being counted.
8. Real anonymous submission from the participant wallet
   (`submitFeedback`, rating 4, comment digest), same finalization gate,
   public tally read before/after from chain state.
9. Negative tests, all against the deployed contract: unregistered
   participant (witness fails closed), invalid rating 7 (on-chain assert),
   closed survey (admin closes → submit → reopens), duplicate nullifier
   (on-chain assert). Results recorded with real tx IDs / statuses only.
10. Report: safe metadata only (addresses, tx IDs, statuses, tallies).

## Secrets & hygiene

| Item | Where it lives | Notes |
|---|---|---|
| `MIDNIGHT_PREPROD_SEED` | environment variable only | never written by the script |
| participant seed | `.participant-seed` (gitignored) | generated once, reused across phases |
| admin secret | `.admin-secret` (gitignored, 0600) | raw secret; only its hash is on-chain |
| SDK log output | redacted by the script | seeds/secrets replaced with `[REDACTED]` |

Both secret files are covered by `.gitignore`. Losing `.admin-secret` loses
admin authority (documented design; there is no recovery path by intent).

## Known pre-fork limitation (documented, not hidden)

While Preprod is pre-fork, the **browser dApp is deploy-ready but cannot join
a contract** (none can exist for this artifact set). The 1AM-wallet path uses
the same v9 stack. After the fork, the flow is exactly as in `docs/USAGE.md`:
set `VITE_CONTRACT_ADDRESS` from phase 2's output and everything works as
built — the frontend has no mock or simulated path.

## Why not just recompile for ledger-v8?

Originally the v8-era stable toolchain was believed to be compact 0.30.0
(language 0.22.0), which cannot compile this source (`pragma
language_version >= 0.23`), so retargeting looked like a source change — out
of scope. That premise was later corrected by direct probe: **compactc 0.31.1
(language 0.23.0, runtime 0.16.0) compiles this exact source unmodified.**

The resolution implements Midnight's official retained-era dual-build pattern
(the same one `midnightntwrk/midnight-wallet-dapp` ships): keep the v9
artifact untouched as the primary build, and add a retained twin
`managed/feedback-v8` built from the SAME `contracts/feedback.compact` via
`npm run compile:v8`, with its generated imports rewritten to the
`compact-runtime-ledger8` alias so one browser install serves both eras.
Deploy that twin to live Preview with `scripts/deploy-preview.mjs` (runbook
below). The Preprod v9 path above stays intact for the fork.

---

# Preview (retained era) Deployment Runbook — scripts/deploy-preview.mjs

Status as of **2026-09-25**: everything is implemented and locally verified;
the single remaining step is human faucet funding (CAPTCHA).

## TL;DR

| Question | Verified answer |
|---|---|
| Does Preview run the ledger-v8 era? | **Yes** — protocolVersion 1000000 at height ~1,011,4xx; the retained v8 artifact is the correct era for this chain. |
| Can the retained artifact deploy there? | **Yes** — compactc 0.31.1 / runtime 0.16.0 artifact ready in `managed/feedback-v8` (16 files, integrity keys + bzkir). |
| Are Preview services reachable? | **Yes** — indexer `https://indexer.preview.midnight.network/api/v4/graphql`, node `https://rpc.preview.midnight.network`, public proof server answering; smoke test (`scripts/smoke-preview.mjs`) passes with all three wallet channels connected and syncing. |
| Does the faucet fund automatically? | **No** — `https://faucet.preview.midnight.network` enforces a browser CAPTCHA (HTTP 400 without token / 403 with dummy). Human step; never bypassed. |
| What is left? | Fund BOTH wallets below in a browser, then run phase 2. |

## Commands

```bash
# 0. One-time environment fixes (idempotent, self-verifying, reversible):
node scripts/patch-wallet-sdk-preprod.mjs      # indexer schema drift (both eras)
node scripts/patch-dust-empty-actions.mjs      # REQUIRED for Preview — see below

# 0b. Optional read-only diagnosis (never submits anything, never moves funds):
node --max-old-space-size=8192 scripts/diag-notnormalized.mjs \
  --contract=<32-byte-hex>

# 1. Connectivity smoke test (no funds needed):
node scripts/smoke-preview.mjs

# 2. Phase 1 — provision both wallets, print fundable addresses:
node --max-old-space-size=8192 scripts/deploy-preview.mjs --fund-status

# 3. HUMAN STEP — fund both printed bech32m addresses with test NIGHT via
#    https://faucet.preview.midnight.network/ in a browser (solve the CAPTCHA).
#    DUST accrues automatically once NIGHT UTXOs are registered.

# 4. Phase 2 — the real deploy + E2E (two full wallet syncs; needs the heap):
node --max-old-space-size=8192 scripts/deploy-preview.mjs

# 4b. Phase 2 against an ALREADY-DEPLOYED contract (skips deployment entirely;
#     the address is re-validated against chain data before use):
node --max-old-space-size=8192 scripts/deploy-preview.mjs --contract <32-byte-hex>
```

Seeds: the admin seed is read from `MIDNIGHT_PREVIEW_SEED` or the gitignored
`.admin-seed-preview`; the participant seed is generated once and persisted to
`.participant-seed-preview`. All log output passes through a redacting logger.

Phase 2 performs the same fail-loud sequence as the Preprod script — era gate
(refuses a post-fork Preview, exit 6), funding check, real `deployContract`
with `[adminIdentity]`, on-chain state read-back + verifier byte-match attach,
registration ×2, real anonymous submission, negative tests (unregistered,
rating 7, closed survey with reopen, duplicate nullifier), tally before/after,
JSON report with safe metadata only.

## Error 117 / NotNormalized — root cause and fix (resolved 2026-09-30)

**Symptom.** The contract **deploy** succeeded on Preview, but **every
subsequent contract call** was rejected by the mempool about a second after
submission:

```
1010: Invalid Transaction: Custom error: 117
```

**This was never a Compact problem.** It is a transaction-pool *normalization*
rejection, and the malformed object is the **DUST segment**, not the contract
call transcript.

**Where 117 comes from.** `midnight-ledger` 8.1.2 has exactly four
`NotNormalized` raise sites. Three are ruled out:

| Site | Ruled out because |
|---|---|
| `verify.rs:1824` — two consecutive `Op::Noop` | the captured transcript has `noop=0, consecutive-noop-pairs=0` |
| `verify.rs:1762/1774` — maintenance-signature ordering | the contract issues no maintenance operations |
| `verify.rs:358` — `maintenance_authority.counter != 0` | the contract issues no maintenance operations |
| **`dust.rs:768` — empty dust actions** | **this is the one that fires** |

```rust
// midnight-ledger 8.1.2  src/dust.rs:768
if self.spends.is_empty() && self.registrations.is_empty() {
    warn!("non-canonical dust actions: empty");
    return Err(MalformedTransaction::NotNormalized);   // -> node error 117
}
```

**Why the wallet produced one.**
`@midnight-ntwrk/wallet-sdk-dust-wallet` `dist/v1/Transacting.js`
`balanceTransactions()` builds the fee-balancing intent and attaches it
**unconditionally**, even when the balancing recipe selected no DUST coin:

```js
const [spends, updatedState] = CoreWallet.spendCoins(state, secretKey, recipeInputs, currentTime);
intent.dustActions = new DustActions(..., [...spends], []);   // spends=[] , registrations=[]
const feeTransaction = Transaction.fromParts(networkId).addIntent(..., intent);
return [feeTransaction, updatedState];                        // attached anyway
```

Measured against the **real** on-chain ledger parameters (fetched from the
Preview indexer, `block { ledgerParameters }`), Preview prices a small contract
call at **fee 0**. So `feeImbalance()` returns `0`, `getBalanceRecipe()`
legitimately selects **no** coin, `spends` is `[]` — and the wallet attaches a
segment the ledger must reject. The deploy worked because its recipe *did*
select one DUST coin (`spends: 1`).

Proof from the real broadcast bytes of the rejected registration, deserialized
with the stable v8 ledger module:

```
intents: { "1":     { actions: [],        dustActions: { spends: [], registrations: [] } },
           "57157": { actions: [ <call> ] } }
```

Reproduce any of this read-only with
`node scripts/diag-notnormalized.mjs --contract=<hex>`.

**The fix.** `scripts/patch-dust-empty-actions.mjs` skips attaching the
fee-balancing intent when it would carry an empty `DustActions`, i.e. exactly
when the ledger's own `dust.rs:768` predicate holds. It is a no-op whenever a
DUST coin *is* needed. Omitting a segment can only leave a transaction
fee-unpaid — which the ledger rejects with an explicit balance error — it can
never make a malformed transaction acceptable.

**Why a patch and not an upgrade.** The defect is still present in the newest
published release: unpacking `@midnight-ntwrk/wallet-sdk-dust-wallet@5.0.0-rc.0`
shows `balanceTransactions` byte-identical to 4.1.0 apart from an import scope
rename, in both `dist/v1` and `dist/v2`. `4.1.0` is also the current `latest` on
npm. There is no fixed version to upgrade to.

**Scope and safety.** Only the two top-level copies reachable by the stable
Preview path are patched (4.1.0 and the hoisted 4.2.0). The nested beta.3 copy
under `testkit-js` belongs to the v9 era and is deliberately left untouched so
the era separation and nested resolution graph stay intact — confirm with
`node scripts/check-resolution-graph.mjs`. The script refuses to run against an
unexpected package version, aborts if the anchor text moved, and reverts
exactly with `--revert`. `deploy-preview.mjs` refuses to start if the patch is
missing, so this failure mode can never silently return.

## Verified result of the fix (2026-09-30, live Preview)

Run: `node --max-old-space-size=8192 scripts/deploy-preview.mjs --contract 916ae63a…`
log: `logs/deploy-preview-run-20260930-014905.log`

| Step | Result |
|---|---|
| Reused contract re-validated on chain | state found; `adminAddress` matched this admin; verifier keys byte-matched |
| `registerParticipant` #1 | **`SucceedEntirely`** — tx carried a real dust spend (`dustSpends: 1`) |
| `registerParticipant` #2 | **`SucceedEntirely`** — fee priced at 0, so **no dust segment was attached at all** (`wouldTriggerEmptyDustActions: false`) |
| Tally after registration | `participantCount: 0 → 2`, `responseCount: 0`, `surveyOpen: true` |
| Independent indexer read-back | `participantCount = 2`, `responseCount = 0`, `usedNullifiers = 0` |

The two registrations exercise **both** branches of the fix: one needed and
spent DUST, the other needed none and therefore emitted no segment. Error 117
is resolved.

## Contract of record

| | |
|---|---|
| Network | Midnight **Preview** |
| Address | `916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc` |
| Era | retained ledger-v8 — `compactc 0.31.1` / `runtime 0.16.0` |
| Deployment tx | `000dc9eee3d4c1236f4f7ac0d17b4b40b0373c99a3b3d50b1994427d0e0548` (block `1079874`) |
| Admin identity | `c6525cdbbbe7692b6167c69a3ed7c21d8aea608499df98ebe21e9c86f281f9b7` |

The v8/v9 split is deliberate and is **not** a temporary state. The contract is
pinned to ledger-v8 because only that era matches the Preview chain's actual
runtime; the v9 build exists for a future mainnet-era switch and must not be
merged with the stable stack.

## End-to-end result: verified 2026-09-30

`npm run deploy:preview -- --contract 916ae6…48248bc` completed the full flow.
`submitFeedback` **finalized on chain**, which was the open blocker.

| op | wallet tx id | on-chain hash | block | status |
|---|---|---|---|---|
| `registerParticipant` #1 | `0019f10c…fd87e8` | `d9f7d13f…aec46` | 1084400 | SucceedEntirely |
| `registerParticipant` #2 | `0090d1aa…fe7cb` | `c39b3c6c…1ad7` | 1084404 | SucceedEntirely |
| **`submitFeedback`** (rating 4) | `00147b45…95f2d` | `25d5fd33…14c3` | **1084410** | **SucceedEntirely** |
| `setSurveyOpen(false)` | `00ae4a69…25c15` | `0327c457…067f2` | 1084415 | SucceedEntirely |
| `setSurveyOpen(true)` | `0088aac7…51bdc` | `f595c8a0…021f7` | 1084419 | SucceedEntirely |

State transitions, all from chain:

```
tally before        : participantCount 2, responseCount 0, rating4 0, usedNullifiers 0
after registration  : participantCount 4, responseCount 0, rating4 0, usedNullifiers 0
after submission    : participantCount 4, responseCount 1, rating4 1, usedNullifiers 1
final               : participantCount 4, responseCount 1, rating4 1, usedNullifiers 1
```

Negative tests — 5/5, each rejected by the contract's own assertion:

| test | rejected by |
|---|---|
| unregistered participant | `ContractRuntimeError: Error executing circuit 'submitFeedback'` |
| rating `7` | `failed assert: rating must be between 1 and 5` |
| survey closed | `failed assert: the survey is not currently accepting responses` |
| duplicate nullifier | `failed assert: this respondent has already submitted feedback` |
| non-admin admin action | `failed assert: only the admin can open or close the survey` |

Note on the negative tests: all five fail at **transaction construction**, i.e.
the witness cannot be produced because a contract assertion aborts. They are
therefore contract rejections, not mempool rejections — the report records that
distinction rather than claiming a ledger-level failure that did not occur.

### Independent re-verification

`npm run verify:onchain -- <contract> <txId>...` re-queries the Preview indexer
and re-derives the contract state **without reading the run log**, so a run log
cannot vouch for itself. It confirms all five transactions are in blocks
(heights strictly increasing, matching the run order) and that the on-chain
tallies match. Persisted evidence: `evidence/preview-e2e-20260930.json`,
`logs/verify-submitfeedback-onchain.log`.

### Exit code now means something

`deploy-preview.mjs` previously printed the report and then called
`process.exit(0)` unconditionally, so a run that failed a step still exited 0 —
the report was evidence, not a verdict. It now gates the exit code on the
report and prints a `VERDICT` block: it fails (exit 7) if any positive step did
not finalize, any negative test was **not** rejected, `submitFeedback` is
missing, `responseCount` is still 0, no nullifier was recorded, or the survey
did not return to the open state.

Caveat: this gate was added *after* the successful run above, so it has been
type-checked and unit-tested but not yet exercised against a live Preview run.
The 2026-09-30 result stands on the on-chain evidence, not on the exit code.

## Resolved blocker: `submitFeedback` — non-terminating balancing loop (2026-09-30)

**Status: fixed and verified on chain.** Kept here because both this and error
117 share a single upstream cause, and the reasoning is what justifies the
patch.

### Symptom

`submitFeedback` never submitted. The run produced no output for ~30 minutes
while burning CPU, then died with:

```
[FATAL] Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) Wallet.Other: unreachable
  [cause]: RuntimeError: unreachable
  at catch (wallet-sdk-dust-wallet/dist/v1/Transacting.js:285)
```

Nothing was broadcast and no funds moved. This looked like a ledger-WASM panic
and was initially mis-diagnosed as a proof-bearing-transaction problem.

### What it actually is

`Wallet.Other` is built at `Transacting.js:285`, the `catch` inside
`computeBalancingRecipe`. That function's loop is:

```js
while (!converged) {
  recipe     = getBalanceRecipe({ initialImbalances: dust -> currentFee });
  newFee     = dryRunFee(recipeInputs, transactions, ...);
  converged  = newFee <= coverage;     // coverage = sum of the recipe's inputs
}
```

Preview prices this contract call at **fee 0**, so the recipe legitimately
selects no DUST coin: `recipeInputs` is empty and `coverage` is `0n`.
Convergence therefore **requires `newFee <= 0`**.

But `dryRunFee()` builds a throwaway intent purely in order to price the
transaction, and it attaches the same **empty `DustActions`** that caused error
117 — an extra intent is not free, so it pushes the price from `0` to `1`:

```
iter  currentFee  newFee  coverage  converged
  1           0       1         0  false
  2           1       1         0  false
  ...                                    (identical forever)
```

`converged` is never true. `Effect.iterate` spins indefinitely, allocating one
throwaway `Transaction` per pass; once the WASM heap is exhausted Rust's
allocation-failure handler aborts and wasm-bindgen reports
`RuntimeError: unreachable`. **The panic is the terminal symptom of a
non-terminating loop, not an independent ledger bug.**

### What it is NOT (all verified by `scripts/diag-submitfeedback.mjs`)

- Not the Compact circuit — witness generation succeeds against real chain
  state, and the participant's secret is a real registered leaf.
- Not the proof — `proveTx` returns in **~8 seconds**, and the proof-bearing
  transaction prices, balances, `eraseProofs()` and `merge()` without incident.
- Not `feesWithMargin` — it returns `0` for the bare call transaction.
- Not error 117 — no dust segment is attached at all in the failing path.

### Fix

The same patch script now also covers `dryRunFee`. When the recipe selects no
coin, price the existing transactions as they are (fee `0`), so coverage `0`
gives `newFee 0 <= 0` and the loop converges on its first pass.
`balanceTransactions` then omits the dust segment entirely.

```
6b. unpatched:  iter 1..8  newFee 1  coverage 0  converged false   (never terminates)
6c. patched  :  iter 1     newFee 0  coverage 0  converged true    (first pass)
```

`registerParticipant` was unaffected only because its cheaper contract call kept
the merged price at `0`; the larger `submitFeedback` transcript is what crosses
the boundary to `1`. That is why deployments and both registrations always
succeeded and only the feedback submission hung.

### One root cause, two symptoms

Error 117 and the hang are the same bug at two different call sites:

| site | symptom |
|---|---|
| `balanceTransactions` merges the empty `DustActions` into the real transaction | the ledger rejects it — error **117** |
| `dryRunFee` merges the empty `DustActions` into a throwaway pricing intent | the price moves `0 → 1`, the balancing loop never converges, the WASM heap dies — **`RuntimeError: unreachable`** |

`scripts/patch-dust-empty-actions.mjs` patches both anchors in one idempotent
pass and is version-gated: it refuses to touch any copy whose `package.json`
version is not the expected one, and it deliberately skips the nested v9-era
`5.0.0-beta.3` copy to keep the eras separate. `npm run patch:revert` restores
the files byte-exactly (verified by hash).
