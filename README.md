# Midnight Private Feedback

**Anonymous, single-use, verifiable survey feedback on the Midnight network.**
A respondent proves in zero knowledge that they were invited and that they have
not already answered — without revealing which registered commitment is theirs.
The rating and the fact that a response happened are public by design; the
participant's identity linkage and private witness material are not.

> **Deployed and verified on Midnight Preview:**
> contract `916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc`
> `submitFeedback` finalized `SucceedEntirely` at block **1084410** on 2026-09-30.
> See [Real Preview deployment evidence](#14-real-preview-deployment-evidence).

---

## Table of contents

1. [Description](#1-description)
2. [Problem](#2-problem)
3. [Solution](#3-solution)
4. [Key features](#4-key-features)
5. [Privacy model](#5-privacy-model)
6. [Architecture](#6-architecture)
7. [Tech stack](#7-tech-stack)
8. [Contract functionality](#8-contract-functionality)
9. [Local setup](#9-local-setup)
10. [Test commands](#10-test-commands)
11. [Build and compile commands](#11-build-and-compile-commands)
12. [Preview deployment instructions](#12-preview-deployment-instructions)
13. [Real Preview deployment evidence](#13-real-preview-deployment-evidence)
14. [On-chain verification](#14-on-chain-verification)
15. [Negative-test behavior](#15-negative-test-behavior)
16. [CI/CD](#16-cicd)
17. [Known limitations](#17-known-limitations)
18. [Security and privacy considerations](#18-security-and-privacy-considerations)
19. [Demo instructions](#19-demo-instructions)
20. [Product proposal and future scope](#20-product-proposal-and-future-scope)
21. [License](#21-license)

---

## 1. Description

This project is a privacy-preserving feedback survey built as a Compact smart
contract on the Midnight network, with a React front end. An organiser deploys
the contract and registers eligible respondents by publishing a commitment to
each respondent's private invite secret. Each registered respondent then
submits a 1–5 rating and an optional free-text comment exactly once. The
contract enforces eligibility and single participation in zero knowledge: it
verifies that the caller holds a secret whose commitment is in the public
Merkle tree, and that the caller's contract-scoped nullifier has not been spent,
without ever revealing which participant submitted. The result is a public,
verifiable tally of who has responded and what they rated, with no on-chain
link between a response and the identity that produced it.

---

## 2. Problem

Feedback channels are only useful if people believe they are protected, and
almost every existing channel fails that test.

- **Surveys leak the responder list.** A platform that emails a survey link
  knows exactly who answered, when, from which address, and often which
  browser. Anonymity is a policy promise, not a cryptographic guarantee.
- **Free-text comments are the highest-risk field.** Even when a rating is
  aggregated, verbatim comments are trivially re-identifiable — workplace
  writing style, project context and named colleagues are identifying.
- **Single participation is unenforceable off-chain.** "One response per
  person" is usually enforced by an email list or a login, which is exactly the
  identity link the process was supposed to avoid.
- **Integrity is taken on trust.** A centralised store can be edited after the
  fact. There is usually no way for a participant to check that the tally is
  the tally that was reported.

The structural problem is that all four of these are *identity* problems, and
ordinary application code cannot solve them — you cannot hide who did something
by being careful with application code alone.

---

## 3. Solution

Move the eligibility, the single-use guarantee and the tally into a Compact
smart contract, and let zero knowledge carry the identity.

1. The organiser registers a **commitment** to each respondent's secret:
   `leaf = H("midnight:feedback:commitment" ‖ secret)`. Only hashes go on chain.
2. At submission the respondent proves membership of the public tree with a
   Merkle path, **without revealing which leaf is theirs**. The circuit
   additionally binds the supplied path to the caller's own secret, so a
   genuine path belonging to somebody else cannot be paired with an unrelated
   secret.
3. Replay is prevented with a **domain-separated, contract-scoped nullifier**:
   `H("midnight:feedback:nullifier" ‖ contractAddress ‖ secret)`. It is unique
   per respondent per survey, is a one-way hash, and because the contract's own
   address is mixed in, the same literal secret produces a different nullifier
   on a different survey — so responses cannot be linked across deployments.
4. The rating is range-checked **inside the circuit before it can touch public
   state**, then increments exactly one public counter.
5. The comment is stored only as a **commitment**, so the plaintext can be
   revealed voluntarily, off-chain, and verified by anyone — but never
   extracted.

The privacy property is therefore precise: *the chain can verify that a
registered, not-yet-spent participant produced this response, without learning
which participant that was.*

---

## 4. Key features

- **Zero-knowledge eligibility.** Merkle membership proof against a public tree
  of commitments, with no leaf disclosure.
- **Nullifier replay protection.** A per-survey, per-respondent nullifier
  makes a second submission cryptographically impossible, not merely
  discouraged.
- **Cross-survey unlinkability.** Nullifiers are scoped to the contract address,
  so the same secret reused across two surveys yields unlinkable nullifiers.
- **In-circuit rating validation.** `rating ∈ [1,5]` is asserted before any
  counter moves, so a rejected call commits nothing.
- **Commit–reveal comments.** Only a hash reaches the chain. Plaintext is
  voluntary and verifiable, never extractable.
- **Admin-gated operations.** Registration and survey open/close require a
  proof of knowledge of the admin preimage; the public `adminAddress` alone
  cannot be replayed as an authorisation.
- **Public, auditable tally.** `responseCount` and the five rating counters are
  public and independently verifiable by anyone reading the ledger.
- **Dual-era toolchain.** The v9 (current) and v8 (retained, live on Preview)
  artifacts are compiled, version-pinned and maintained separately.
- **A real DUST runtime patch** that is version-gated, idempotent, byte-exactly
  reversible and verified not to leak across eras — see
  [Known limitations](#17-known-limitations).

---

## 5. Privacy model

This section is deliberately exact. Overstating what a zero-knowledge
transaction hides is the most common failure mode in privacy-oriented projects,
so the claims below are limited to what the deployed contract actually does.

### What is PRIVATE

| Value | Why it never reaches the ledger |
|---|---|
| The participant's invite **secret** | Only `H(tag ‖ secret)` is published. Never disclosed, never transmitted in plaintext. |
| The **Merkle path** witness | Consumed inside the circuit. Compact witnesses are private inputs. |
| **Which** registered commitment is the caller's | The circuit proves membership of *some* leaf without revealing which. |
| The **private state** (secret, rating, comment digest) per contract | Held by the private-state provider in the respondent's own browser/wallet. |
| The **plaintext comment** | Only `H("midnight:feedback:comment" ‖ comment)` is written to the ledger. |
| The **admin secret** | A domain-separated commitment of it (`adminAddress`) is pinned at construction; the preimage is proved, never disclosed. |
| The secret used to derive the **participant nullifier** | The nullifier is a one-way hash of it. Knowing the nullifier does not yield the secret. |

### What is PUBLIC and observable

| Value | Where it is visible |
|---|---|
| The **contract address** | Public, and by design — it is the survey's identity. |
| **Survey open/closed** state | `surveyOpen` ledger field. |
| **Participant count** | `participantCount` ledger field. |
| **Response count** | `responseCount` ledger field. |
| **Public rating tally** | `rating1`…`rating5` ledger counters. |
| **Nullifier usage/state** | `usedNullifiers` map — required for duplicate prevention, and unavoidable given it enforces the guarantee. |
| **Comment commitments** | `commentCommitments` map, keyed by nullifier. Hashes only. |
| **Transaction and block metadata** | Ordinary public chain data: transaction id, hash, block height, timestamp, fee, gas. |
| **The fact that a feedback transaction occurred** | Inherently public. The ledger shows a state transition. |
| **The submitted rating value** | Public — see below. |

### The rating is public, by design

The contract deliberately writes `const rating = disclose(feedbackRating())`
and increments one of five public counters. This is a design decision, not an
oversight: a public tally of ratings is the product. The consequence must be
stated plainly:

> **Each submitted rating is publicly inferable from the public ledger.**

A reviewer should read this as "the score is public; the respondent is not."

### What the privacy mechanism actually protects

The mechanism protects **the link between a response and the identity that
produced it**, plus the private witness material needed to produce it. Concretely
it prevents:

- linking a response to a registered participant commitment,
- deriving a participant secret (or admin secret) from anything on chain,
- correlating one respondent's nullifier across two different survey
  deployments,
- extracting a comment's plaintext from the chain.

It does **not** make a transaction invisible, and no claim is made that it does.

### Two phrases that are not interchangeable

| Claim | Accurate? |
|---|---|
| "Anonymous feedback" | **Acceptable, with the qualifier below.** |
| "Private feedback" | **Acceptable.** The rating tally is public by design. |
| "The transaction is hidden" | **False.** It is fully visible. |
| "Ratings are private" | **False.** They are disclosed and tallied publicly. |
| "Invisible" / "untraceable" | **False**, and never claimed here. |

The honest description of this system is:

> **A publicly observable feedback transaction with privacy-preserving
> participant authentication.**

The respondent is *unidentified in the ledger's data model* — that is what the
zero-knowledge proof buys. The transaction itself, its timing, its authorising
account and the rating it discloses are all ordinary public chain facts. A
determined adversary who can correlate wallet addresses, IP addresses or
timing with off-chain context is outside the guarantee of this design, and this
project does not claim otherwise.

---

## 6. Architecture

```
contracts/feedback.compact          The Compact contract (single source of truth)
        │
        │  compactc 0.34.0 / 0.31.1
        ▼
managed/feedback                    v9 artifact  (current era;  Preprod)
managed/feedback-v8                 v8 artifact  (retained era; live Preview)
        │  zkir / prover / verifier keys
        ▼
src/lib/midnight/                   Provider wiring, era switch, wallet adapter
src/lib/referenceModel.ts           Pure-JS specification double (tests only)
src/components/                     React UI
        │
        ▼
Midnight Preview  ── indexer ── rpc ── proof server
```

### Two eras, deliberately separated

Midnight is mid-fork. A Compact artifact is pinned to the compiler and runtime
of its era and **cannot** be used on a chain of a different ledger version.

| | Current era (v9) | Retained era (v8) |
|---|---|---|
| Artifact | `managed/feedback` | `managed/feedback-v8` |
| Compiler | `compactc 0.34.0` | `compactc 0.31.1` |
| Runtime | `0.19.0` | `0.16.0` |
| SDK line | `midnight-js-* 5.0.0-beta.8` | `testkit-js 4.1.1` (stable) |
| Network | Preprod — **after** the ledger-v9 fork | **Preview — live now** (ledger-v8) |
| Build | `npm run build` | `npm run build:preview` |

The live, verified deployment uses the **retained v8 artifact and runtime
path**, because Preview still reports `protocolVersion 1000000` (pre-fork). The
current v9 artifact is maintained, compiled and tested in parallel, and takes
over automatically once the v9 fork is enacted. The selection is a build-time
switch, `VITE_MIDNIGHT_ERA`, resolved in `src/lib/midnight/era.ts`, which is
the single source of truth — including the `ERA_LABEL` the UI renders, so the
demo always names its era accurately.

The two toolchains never mix. `scripts/check-resolution-graph.mjs` asserts that
no stable-era package resolves a runtime class-provider to the top-level
beta.8 copy, and it **fails the build** if it ever does.

---

## 7. Tech stack

| Layer | Technology |
|---|---|
| Smart contract | [Compact](https://docs.midnight.network) (Midnight's ZK circuit language) |
| Compiler | `compactc` 0.34.0 (v9 era) / 0.31.1 (v8 era) — both version-pinned |
| On-chain runtime | `@midnight-ntwrk/compact-runtime` 0.19.0 (v9) / 0.16.0 (v8) |
| ZK proving | Midnight proof server (`proof-server.preview.midnight.network`) |
| Chain access | `midnight-js-*` 5.0.0-beta.8 (v9) / `testkit-js` 4.1.1 stable (v8) |
| Front end | React 18 + TypeScript 5.5 |
| Build | Vite 5 |
| Tests | Vitest 2 |
| Styling | Plain CSS |
| CI | GitHub Actions |

The contract source is identical for both eras; only the compiler differs.

---

## 8. Contract functionality

`contracts/feedback.compact` — three exported circuits and one constructor.

### Ledger state

| Field | Type | Meaning |
|---|---|---|
| `participants` | `HistoricMerkleTree<10, Bytes<32>>` | Public commitments of registered respondents |
| `participantCount` | `Counter` | How many have been registered |
| `usedNullifiers` | `Map<Bytes<32>, Boolean>` | Spent single-use nullifiers |
| `responseCount` | `Counter` | Unique respondents who have submitted |
| `rating1`…`rating5` | `Counter` | The public tally |
| `commentCommitments` | `Map<Bytes<32>, Bytes<32>>` | Comment hashes, keyed by nullifier |
| `surveyOpen` | `Boolean` | Whether responses are accepted |
| `adminAddress` | `Bytes<32>` | Public commitment authorising admin circuits |

### Constructor

```
constructor(admin: Bytes<32>)
  adminAddress = disclose(admin)
  surveyOpen   = true
```

### `registerParticipant(leaf) — admin only`

Asserts `adminIdentity(adminSecret()) == adminAddress`, inserts the disclosed
commitment into the tree, increments `participantCount`.

### `setSurveyOpen(isOpen) — admin only`

Same authorisation assert; flips `surveyOpen`.

### `submitFeedback()` — the core circuit

```
assert surveyOpen
secret   = participantSecret()
rating   = disclose(feedbackRating())          // PUBLIC by design
comment  = feedbackComment()                   // private, hashed only

leaf     = H("midnight:feedback:commitment", secret)
path     = participantMerklePath(leaf)
assert path.leaf == leaf                        // binds the path to THIS secret
assert participants.checkRoot(merkleTreePathRoot(path))

nullifier = H("midnight:feedback:nullifier", contractAddress, secret)
assert !usedNullifiers.member(nullifier)
usedNullifiers.insert(nullifier, true)
responseCount.increment(1)

assert rating >= 1 && rating <= 5               // BEFORE any counter moves
increment exactly one of rating1..rating5

commentCommitments.insert(nullifier, H("midnight:feedback:comment", comment))
```

The `assert(path.leaf == leaf)` line is load-bearing. Without it, an attacker
could present a *genuine* Merkle path belonging to a different registered
participant (whose root still matches) while spending an unrelated secret of
their own. This exact attack is regression-tested — see
`tests/feedback.contract.test.ts`,
*"rejects an incorrect secret presented together with another participant's
genuine Merkle path"*.

### Witnesses (all private, all off-chain)

`participantSecret`, `participantMerklePath`, `feedbackRating`,
`feedbackComment`, `adminSecret`.

---

## 9. Local setup

**Requirements:** Node.js ≥ 22, npm, and the Compact compiler (installed by the
CI action or by `cargo install compact` / your preferred toolchain route).

```bash
# 1. install
npm ci

# 2. compile both contract eras (required before `npm test`)
npm run compile:v9     # -> managed/feedback      (compactc 0.34.0)
npm run compile:v8     # -> managed/feedback-v8   (compactc 0.31.1)

# 3. frontend configuration
cp .env.example .env
#    set VITE_CONTRACT_ADDRESS and VITE_MIDNIGHT_ERA for the era you want
#    see .env.example — never commit a real .env

# 4. run it
npm run dev            # default: v9 era
npm run build:preview && npm run preview   # Preview (v8) era
```

To target the live Preview contract, set in `.env`:

```bash
VITE_MIDNIGHT_ERA=v8-preview
VITE_MIDNIGHT_NETWORK_ID=preview
VITE_CONTRACT_ADDRESS=916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc
```

The dev server also mounts both artifact directories over HTTP
(`/contract/managed/feedback` and `/contract/managed/feedback-v8`) so the
browser can fetch the ZK keys, so a single dev server serves either era.

**Runtime patch.** The Preview deployment path requires one `node_modules`
patch, applied with:

```bash
npm run patch:dust       # or: node scripts/patch-dust-empty-actions.mjs
```

`npm ci` wipes it, so run this after every install. See
[Known limitations](#17-known-limitations) for what it does and why.

---

## 10. Test commands

```bash
npm test                  # everything (58 tests)
npx vitest                # watch mode
```

| Command | Covers |
|---|---|
| `npm test` | All 58 tests across 5 files |
| `npx vitest run tests/feedback.contract.test.ts` | The 17 tests that execute the **real generated Compact circuits** |
| `npx vitest run tests/feedback-reference-model.test.ts` | The 11 pure-JS specification tests |
| `npx vitest run tests/wallet.test.ts` | The 11 wallet-discovery tests |
| `npx vitest run tests/crypto.test.ts` | The 6 secret/digest helper tests |
| `npx vitest run tests/deploy-verdict.test.ts` | The 13 deployment exit-gate tests |

### What the 17 contract tests demonstrate

These run the compiled circuits through the real
`@midnight-ntwrk/compact-runtime` and assert the ledger's actual state after
each call.

| Requirement | Test |
|---|---|
| **Valid contract behaviour** | *"accepts a registered respondent and commits tally, nullifier and comment commitment"* — asserts `responseCount=1`, `rating4=1` and **only** `rating4`, the nullifier is present, the comment commitment is the tagged hash and not the plaintext, and the proof trace contains four private outputs. |
| **Duplicate / nullifier protection** | *"rejects a duplicate submission via the spent nullifier"* — resubmits the same secret **with a different rating**; asserts the rejection, that `responseCount` is still 1, the nullifier count is still 1, `rating2` is still 0 and `rating4` is still 1. |
| **Rating validation** | *"rejects ratings outside 1-5 without committing any partial state"* — rejects 0 and 6, asserts nothing moved, then proves a valid rating 3 *does* succeed, so the failed calls genuinely spent nothing. |
| **Admin authorisation** | *"accepts the correct admin secret…"* / *"rejects an incorrect admin secret and leaves the ledger untouched"* for registration, and the positive/negative pair for `setSurveyOpen`. |
| **Survey state behaviour** | *"initializes an open survey…"* and *"rejects submissions while the survey is closed and accepts them after reopening"*. |
| **Security regression** | *"rejects an incorrect secret presented together with another participant's genuine Merkle path"* — the leaf-binding attack described in §8. |
| **Privacy invariants** | *"keeps nullifiers domain-separated, contract-scoped, and never stores comment plaintext"* — the same secret under a different contract address yields a different nullifier. |

`tests/feedback-reference-model.test.ts` deliberately re-states the same rules
against a pure-JS model. It is a specification double and is kept separate so
it can never mask a real contract bug — the test above is exactly the bug it
would have hidden.

> **What these tests cannot do.** They execute the real circuits and assert
> real ledger state, but they do **not** generate or verify a ZK proof and do
> **not** submit anything to a node. Proof generation requires the proof
> server; transaction submission requires a funded wallet. That is what the
> live Preview run is for (§13).

---

## 11. Build and compile commands

```bash
npm run compile        # alias for compile:v9
npm run compile:v9     # -> managed/feedback      (compactc 0.34.0, runtime 0.19.0)
npm run compile:v8     # -> managed/feedback-v8   (compactc 0.31.1, runtime 0.16.0)
npm run lint           # tsc --noEmit
npm run build          # tsc -b && vite build               (v9 era)
npm run build:preview  # tsc -b && vite build --mode preview-era   (v8 era)
npm run check:offline  # lint + resolution graph + DUST patch verification
```

Compiler versions are pinned explicitly per era (`+0.34.0` / `+0.31.1`) rather
than tracking a `latest` tag, so identical source reproduces identical
artifacts. `managed/` is gitignored; regenerate it with the commands above.

---

## 12. Preview deployment instructions

These are the commands actually used to produce the verified run. They require
funded Preview wallets and are **not** part of CI.

```bash
# 0. apply the required runtime patch (npm ci wipes it)
npm run patch:dust

# 1. phase 1 — print the addresses you need to fund
MIDNIGHT_PREVIEW_SEED=<hex> npm run deploy:preview -- --fund-status

#    Fund BOTH printed addresses via the official Preview faucet:
#    https://faucet.preview.midnight.network
#    (The automated drip API is CAPTCHA-gated and is expected to be rejected;
#     funding is a human step. An unfunded wallet is a loud blocker, never a
#     simulated success.)

# 2. phase 2 — deploy + full end-to-end run, or re-validate an existing one
npm run deploy:preview                       # deploy, then run the E2E
npm run deploy:preview -- --contract 916ae63a...bc   # re-use, nothing deployed

# 3. pre-flight the wallet/chain without deploying
npm run smoke:preview

# 4. verify the deployment independently
npm run verify:preview
```

The script is era-gated: it reads the chain tip and **refuses to deploy** if
Preview has enacted the ledger-v9 fork (`protocolVersion >= 2000000`), rather
than silently failing. A reused `--contract` address is fully re-validated from
chain data — state present, verifier keys byte-match, and the on-chain admin
identity belongs to this run's admin wallet — before any transaction work.

---

## 13. Real Preview deployment evidence

**Network:** Midnight Preview
**Contract:** `916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc`
**Era:** retained ledger-v8 (`compactc 0.31.1` / runtime `0.16.0`)
**Date:** 2026-09-30

| Step | Result |
|---|---|
| Contract deployment | `SucceedEntirely` |
| `registerParticipant` × 2 | `SucceedEntirely` |
| **`submitFeedback` (rating 4)** | **`SucceedEntirely` — block 1084410** |
| `responseCount` | 0 → **1** |
| `rating4` tally | 0 → **1** |
| `usedNullifiers` | 0 → **1** |
| `setSurveyOpen(false)` | `SucceedEntirely` |
| `setSurveyOpen(true)` | `SucceedEntirely` |
| Negative tests | 5/5 rejected (see §15) |
| `npm run verify:onchain` | 6/6 PASS |

Full machine-readable evidence, committed in the repository:

- [`evidence/preview-e2e-20260930.json`](evidence/preview-e2e-20260930.json) —
  the run report, plus an **independent** re-verification performed by querying
  the indexer directly rather than reading the run log.
- [`evidence/preview-run-log-excerpt-20260930.txt`](evidence/preview-run-log-excerpt-20260930.txt) —
  scrubbed verbatim excerpts of the run log. The full log is gitignored because
  it contains absolute local filesystem paths in stack traces.

Independent re-verification confirms block ordering
`1084400 → 1084404 → 1084410 → 1084415 → 1084419`, strictly increasing.

> **An honest note about the run itself.** This run re-validated an existing
> contract via `--contract`, so it broadcast **no** contract-deployment
> transaction; the address was re-verified against chain state and the
> verifier keys were byte-matched on attach. The `submitFeedback` transaction
> is a genuine, freshly broadcast, real transaction.

---

## 14. On-chain verification

```bash
npm run verify:onchain
```

Re-queries the Preview indexer directly and does **not** read the deployment
log, so it is a genuine second opinion. It checks 6 assertions and reports
6/6 PASS. The result is recorded under
`evidence/preview-e2e-20260930.json → independentOnChainVerification`.

> This command requires network access and is therefore **not** a CI gate. The
> deterministic CI path covers compilation, tests, typecheck, builds, the
> resolution graph and the DUST patch; on-chain correctness is evidenced by a
> committed result rather than by a live network call.

---

## 15. Negative-test behavior

Five negative cases are attempted against the real deployed contract on Preview:

| Case | Expected | Contract assertion that fired |
|---|---|---|
| Unregistered participant | reject | `not a registered respondent for this survey` |
| Rating 7 | reject | `rating must be between 1 and 5` |
| Closed survey | reject | `the survey is not currently accepting responses` |
| Duplicate nullifier | reject | `this respondent has already submitted feedback` |
| Unauthorized admin action | reject | `only the admin can open or close the survey` |

### Read this precisely

All five were rejected **during transaction construction**, not by the mempool.
In each case the circuit assertion aborts while the witness is being produced,
so no transaction is ever signed, submitted or broadcast. Every recorded
`actual` field literally begins `construction-failure-before-submission:`.

This is a weaker and different claim from "the network rejected it", and this
project does not make the stronger one. What the five cases do demonstrate,
accurately, is that **the contract's own assertions reject all five invalid
attempts** — the rejection logic lives in the circuit, not in client-side
validation or a UI check, and the deployed artifact enforces it.

The one genuinely different historical case is documented in §17: the empty
`DustActions` defect *was* a mempool rejection (node error 117). Do not
conflate the two.

---

## 16. CI/CD

`.github/workflows/ci.yml` runs on **every push and every pull request**.

| Step | What it proves |
|---|---|
| `npm ci` | Lockfile-exact, reproducible install |
| `npm run check:resolutions` | v8/v9 era separation holds; **fails the build** if it does not |
| `npm run check:dust-patch` | The DUST patch applies, is idempotent, is byte-exactly reversible, and does **not** leak into the nested v9-era copy |
| `npm run compile:v9` / `compile:v8` | Both era artifacts build from the same source, with pinned compilers |
| `npm test` | All 58 tests, including the 17 that execute the real generated circuits |
| `npm run lint` | Typecheck clean |
| `npm run build` / `build:preview` | Both era bundles build |
| Artifact + patch assertions | Both era artifacts exist; the DUST patch is applied at end of run |
| `git diff --exit-code -- contracts/` | The build never mutates the contract source |

**Properties of the CI path, by design:**

- **No secrets.** No key, seed, token or `.env` value is read or needed.
- **No network dependency for correctness.** It never contacts Preview, a proof
  server, or an RPC endpoint. The only network use is fetching npm packages.
- **No funding required.** Nothing deploys or broadcasts.
- **Deterministic.** Compiler versions are pinned per era rather than tracking
  `latest`.

---

## 17. Known limitations

Stated plainly, including the parts that are unflattering.

### The rating and the transaction are public

The single most important caveat. `disclose(feedbackRating())` plus five
public counters means the submitted score is on-chain. What is hidden is *who*
submitted it. Anyone describing this project as hiding ratings or hiding the
transaction is wrong.

### No anonymity against a correlating observer

The zero-knowledge proof guarantees that the *ledger's data model* does not
link a response to a registered commitment. It does not defend against an
adversary who can correlate your Midnight account, IP address, submission
timing and off-chain context. Treating "zero knowledge" as "anonymous" without
that qualifier would be a false claim.

### The DUST runtime patch

**Why it exists.** On the retained ledger-v8 path, the wallet SDK's
`balanceTransactions()` attaches a fee-balancing intent to every transaction
*unconditionally*. When the balancing recipe selects no DUST coin — which is
correct for a contract call that owes no dust fee — the attached `DustActions`
carries neither spends nor registrations. Midnight ledger 8.1.2 rejects exactly
that shape as non-canonical:

```
midnight-ledger 8.1.2  src/dust.rs:768
  if self.spends.is_empty() && self.registrations.is_empty() {
    warn!("non-canonical dust actions: empty");
    return Err(MalformedTransaction::NotNormalized);   // -> node error 117
  }
```

Symptom: the contract deployed successfully (its recipe did select a coin),
while **every subsequent contract call was rejected by the mempool** with
`1010: Invalid Transaction: Custom error: 117`. The same empty shape in
`dryRunFee()` was worse: it made fee pricing diverge forever, because pricing
an empty balancing intent added a second intent's cost and therefore never
converged — which is why `submitFeedback` used to hang during proving.

**What it changes.** It skips attaching the fee-balancing intent when that
intent would be empty. It is a no-op in the normal case, and strictly safer
than the status quo: an omitted segment can only leave a transaction
fee-unpaid, which the ledger rejects with an explicit balance error — it can
never make a malformed transaction acceptable.

**Why a patch and not an upgrade.** The defect is present in the newest
published release; the `balanceTransactions` body is byte-identical to 4.1.0
apart from an import rename. There is no fixed version to upgrade to.

**Why it is needed for this path specifically.** It is a wallet-SDK defect on
the stable v8-era stack used to reach Preview. It is not a property of the
contract, and it is not part of the v9 toolchain.

**Its guarantees, all verified by `npm run check:dust-patch` in CI:**

- **Version-gated.** It refuses to run against any package version other than
  the two it was written for, and aborts if the upstream anchor text has moved.
- **Idempotent.** Re-running changes nothing.
- **Reversible.** `npm run patch:revert` restores the files byte-exactly
  (sha256-verified, not just sentinel-checked).
- **Era-safe.** It touches only the two v8-era copies the Preview path can
  resolve. The **nested v9-era `5.0.0-beta.3` copy is deliberately left
  unpatched**, and CI asserts that it carries no patch sentinel — so the era
  separation this repository depends on cannot be silently destroyed.

**The honest weak point:** it lives in `node_modules` and is therefore
destroyed by every `npm ci`/`npm install`. The script is the durable record and
the one-command repair, and CI re-applies and re-verifies it on every push, but
there is no postinstall hook enforcing it. The deploy script refuses to start
unpatched rather than failing mysteriously later.

### The deployment exit gate is locally tested, not live-tested

`scripts/deploy-preview.mjs` now gates its exit code on the generated report
instead of exiting 0 unconditionally. That gate is verified by
`tests/deploy-verdict.test.ts` — 13 offline cases including the recorded
2026-09-30 report — and **not** by a live deployment. No additional deployment
was performed just to exercise it, deliberately. The run log in `evidence/`
predates the gate for this reason, and says so.

### The v8 artifact is not covered by the automated test suite

All 17 contract tests bind the **v9** artifact (`managed/feedback`). The
**v8** artifact is what is live on Preview, and it is compiled in CI but not
exercised by the suite. It is verified instead by the live Preview run and
`npm run verify:onchain`. This is a real coverage gap.

### Other limitations

- **Single admin, no key rotation.** `adminAddress` is fixed at construction.
  Losing the admin secret loses admin authority permanently.
- **No comment reveal UI.** The commit–reveal verification is described and
  proven by hash, but there is no front-end affordance for it yet.
- **Preprod is blocked by the chain, not by this project.** The v9 path cannot
  be deployed until the ledger-v9 fork is enacted. This is a verified,
  reproducible chain-era fact, not an implementation gap.
- **Testing stops short of proving.** The suite runs the real circuits and
  asserts real state, but no test generates a ZK proof or submits a
  transaction.
- **Faucet funding is a manual human step.** The automated drip API is
  CAPTCHA-gated.

---

## 18. Security and privacy considerations

### What the contract guarantees

- **Eligibility cannot be forged.** Producing a valid witness requires the
  actual secret; the Merkle path is bound to that secret's commitment, so a
  valid path cannot be paired with an unrelated secret.
- **Double submission is cryptographically impossible**, not merely rejected
  by application logic.
- **Rating range is enforced in-circuit, before any public state moves.** A
  rejected call commits nothing — proven by test, not just by inspection.
- **Admin actions require a preimage.** The public `adminAddress` cannot be
  replayed as an authorisation, because the circuit checks
  `adminIdentity(adminSecret()) == adminAddress`.
- **Comments are stored as hashes only.** Plaintext cannot be extracted; it can
  only be voluntarily revealed and then verified.
- **Nullifiers are contract-scoped**, so a secret reused across deployments
  cannot be correlated by nullifier.

### What the contract does not guarantee

- **Not anonymity against a correlating observer** — see §5 and §17.
- **Not protection of the rating** — it is disclosed by design.
- **Not protection against a compromised admin.** A malicious admin can
  register arbitrary commitments and open/close the survey at will. Admin
  authority is a trusted role, not a decentralised one.
- **Not forward secrecy for a leaked secret.** If a participant's secret leaks,
  their commitment and nullifier become attributable to them. The secret should
  be treated as long-lived key material.
- **Not anonymity of the transaction** — timing, fees and the authorising
  account are public.

### Operational security in this repository

- The admin seed, participant seed and admin secret are read from the
  environment or from gitignored files (`.admin-seed-preview`,
  `.participant-seed-preview`, `.admin-secret-preview`). They are never
  printed: a shared redacting logger scrubs every SDK log line, and the
  committed evidence files contain public chain data only.
- `npm run deploy:preview` and related scripts are era-gated and fail loudly
  rather than fabricating a result.
- CI requires no secrets and no funded account.

---

## 19. Demo instructions

A 60-second storyboard is in [`docs/DEMO.md`](docs/DEMO.md), with a shot list
and an explicit list of the screenshots still to be captured.

To run the dApp locally against the live Preview contract:

```bash
npm ci
npm run patch:dust
npm run compile:v8
npm run build:preview && npm run preview
```

with `.env` set to `VITE_MIDNIGHT_ERA=v8-preview`, `VITE_MIDNIGHT_NETWORK_ID=preview`
and the contract address from §13. Connecting requires a Midnight wallet
extension (the front end discovers 1AM specifically and deliberately ignores
Lace).

> A note on the deployed front end: `managed/` is gitignored and `vite build`
> does not copy the ZK keys into `dist/`. Hosting the compiled artifacts is a
> deployment concern — serve `managed/feedback-v8` at `/contract/managed/feedback-v8`.
> Until that is done, the reliable demo is the local `npm run dev` flow plus the
> recorded evidence in `evidence/`.

---

## 20. Product proposal and future scope

The full proposal is in [`PROPOSAL.md`](PROPOSAL.md).

**Target users:** organisations running internal pulse surveys, HR and
compliance teams, community operators, and any group that needs aggregate
sentiment without a roster attached to it.

**Core product:** deploy a survey, distribute one-time invite secrets out of
band, and let respondents answer once from a browser wallet. The organiser gets
a public, independently verifiable tally; respondents get a real cryptographic
guarantee that their response cannot be tied to their identity.

**MVP scope (shipped):** the survey contract, the respondent and admin flows,
the public tally, nullifier replay protection, and a browser dApp.

**Future scope, honestly ordered by value:**

1. **Multi-question surveys** and configurable rating scales.
2. **Organiser analytics** — free-text clustering over voluntarily revealed
   comments, with an explicit consent step per respondent.
3. **Result commitment and publication** — commit to a result hash up front,
   reveal later, so the organiser cannot quietly change the reported numbers.
4. **A survey factory** that deploys a fresh contract per survey automatically,
   which would also make the contract-scoped nullifier property visible to
   users rather than merely theoretical.
5. **Credential-based eligibility** beyond one-secret-per-person, e.g. proofs
   of "I am over 18" or "I attended this session" without disclosing which
   attendee.
6. **On-chain results retrieval** through the public data provider, so third
   parties can verify a survey's outcome without trusting the organiser.

**Risks:** the public rating removes the most common objection to anonymous
feedback ("they can find out who said what"); correlation attacks at the
network layer are out of scope of the ZK guarantee; the admin is a trusted
role; and the live path currently depends on a patched wallet SDK until the
v9 toolchain is deployable.

**Success metrics:** would be measured as surveys deployed, unique
participants who submit at least one response, and the share of responses to
organiser-issued invitations. **No such usage data exists yet — this project
has not been fielded, and no adoption numbers are claimed.**

---

## 21. License

The contract and this repository are provided as submitted project work. A
licence has not been chosen by the author; add one before publishing if the
submission requires an explicit grant.
