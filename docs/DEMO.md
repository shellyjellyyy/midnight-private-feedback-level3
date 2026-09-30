# 60-Second Demo — Storyboard

Everything below is something that can be shown on screen. Nothing here claims
a capability that has not been verified. Where a shot depends on something not
yet captured, it is marked **[NEEDS CAPTURE]** and listed in §3.

Two demos are described. **Demo A** is the reliable one and should be the
default: it uses real, already-verified on-chain data and does not depend on a
live funded wallet. **Demo B** is the full live dApp, which needs a funded
Preview wallet and takes longer than 60 seconds.

---

## 1. Demo A — 60 seconds, zero dependencies, fully honest

Runs from a terminal plus the two evidence files. No wallet, no funding, no
network dependency at demo time. **This is the recommended demo.**

| Time | On screen | What you say |
|---|---|---|
| **0–10s** | Title + the README's "Deployed and verified on Midnight Preview" banner showing the contract address and block 1084410 | "Anonymous survey feedback on Midnight. A respondent proves they're eligible and that they haven't already answered — in zero knowledge, without revealing *which* registered participant they are." |
| **10–25s** | `contracts/feedback.compact` open at `submitFeedback`, highlighting the Merkle membership assert and the nullifier assert | "Eligibility is a Merkle membership proof against a public tree of commitments. No leaf is ever disclosed. Replay is prevented by a nullifier that's domain-separated *and* scoped to this contract's own address — so the same secret on a different survey gives an unlinkable nullifier." |
| **25–40s** | `npm test` output, or the `evidence/preview-e2e-20260930.json` `runReport` block showing `submitFeedback: SucceedEntirely` | "This isn't a mock. On Preview, `submitFeedback` finalized at block 1084410. The tally went from `responseCount` 0 to 1, `rating4` 0 to 1, and `usedNullifiers` 0 to 1." |
| **40–50s** | The `independentOnChainVerification` block of the same file, showing block ordering `1084400 → 1084404 → 1084410 → 1084415 → 1084419` | "And that's verified independently — a second tool re-queried the indexer directly rather than trusting the deployment log." |
| **50–60s** | The privacy table from README §5 | "Be precise about what this hides. Your secret, your witness, your comment text — private. Your identity link to the response — private. Your rating, and the fact that the transaction happened — **public by design**. This is a publicly observable transaction with privacy-preserving authentication, not an invisible one." |

**If asked "is the rating private?"** — the honest answer, which you should give
unprompted if there is time: no. The contract deliberately discloses it. What
is private is *who* rated.

---

## 2. Demo B — live dApp, ~3–5 minutes, needs a funded Preview wallet

Not a 60-second demo. Use it if there is time for it, or as a follow-up.

```bash
npm ci
npm run patch:dust          # required runtime patch, see README §17
npm run compile:v8          # builds the retained Preview-era artifact
npm run build:preview && npm run preview
```

with `.env`:

```bash
VITE_MIDNIGHT_ERA=v8-preview
VITE_MIDNIGHT_NETWORK_ID=preview
VITE_CONTRACT_ADDRESS=916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc
```

| Time | On screen | What you say |
|---|---|---|
| 0–15s | The dApp: "Connect 1AM Wallet", survey card, rating 1–5 | "One click to connect a Midnight wallet, pick a rating, submit." |
| 15–45s | Click Connect → approve in 1AM → address appears; pick rating **4**; type a comment; Submit | "Your browser generates the ZK proof locally. Watch the status line move through proof generation to submission." |
| 45–75s | "Feedback recorded" + the public tally incrementing | "Done. One bucket went up by one." |
| 75–105s | Reload / show the public state | "Response count and the tally are public and independently verifiable. The respondent behind them is not." |
| 105–135s | Try to submit again with the same browser secret | "Rejected: this respondent has already submitted feedback. That's a contract assertion, not a UI check." |

> **Caveat to state if asked:** the local `npm run preview` flow serves the
> compiled ZK artifacts from the dev server, because `vite build` does not copy
> `managed/` into `dist/`. A public URL additionally needs the artifact
> directory hosted at `/contract/managed/feedback-v8`. There is no public
> deployment yet.

---

## 3. Screenshots still needed

These cannot be generated automatically. Capture them yourself with the exact
instructions below.

### A. Tests passing — **[NEEDS CAPTURE]**

Run from the repository root:

```bash
npm ci
npm run compile:v9
npm run compile:v8
npm test
```

Capture the **complete terminal window** at the end, showing:

```
Test Files  5 passed (5)
     Tests  58 passed (58)
```

Make sure the visible test files include `tests/feedback.contract.test.ts`
(17 tests) — that is the one that executes the real generated Compact circuits,
and it is the most convincing file in the run. A tighter alternative worth
capturing as a second image:

```bash
npx vitest run tests/feedback.contract.test.ts
```

which shows the 17 real-circuit tests, including the duplicate-nullifier,
rating-validation, admin-authorisation and closed-survey cases by name.

### B. CI workflow passing — **[NEEDS CAPTURE, only after the first real run]**

This is **not yet available** — no GitHub repository exists and no Actions run
has happened. Once you have pushed:

1. Open the repository's **Actions** tab.
2. Open the most recent successful `CI` run.
3. Capture the job summary page showing the green check and the full step list
   (resolution graph → dust patch → compile v9 → compile v8 → tests → typecheck
   → build ×2 → artifact assertions).

**Do not fabricate this screenshot.** Until a real run exists, describe CI as
"configured, not yet executed".

### C. Live Preview dApp — **[NEEDS CAPTURE, needs a funded wallet]**

Using Demo B above. Capture four moments:

1. The landing card with the connect button, before connecting.
2. Connected, address shown, rating **4** selected, comment typed in.
3. The "Feedback recorded" state.
4. The public tally after submission, showing `responseCount` incremented.

### D. On-chain verification / transaction evidence — **[NEEDS CAPTURE]**

Either of these, both reproducible:

```bash
npm run verify:onchain
```

Capture the terminal showing **6/6 PASS**. This re-queries the indexer and does
not read the deployment log, so it is the strongest single artefact in the
project.

Alternatively open the evidence file that is already committed:

```bash
code evidence/preview-e2e-20260930.json
```

and screenshot the `independentOnChainVerification` block, which shows the
`submitFeedback` transaction hash and block 1084410.

### Optional but strong

```bash
npm run check:dust-patch
```

Screenshots the "applies, is idempotent, is byte-exactly reversible, preserves
era separation" output — a good answer to "is that patch a hack?".

---

## 4. Questions you should expect, and the honest answers

**"Is this really anonymous?"**
In the ledger's data model, yes — no registered commitment is linked to a
response. It is not invisible: the transaction, its timing and your rating are
public. A network-level correlating adversary is out of scope.

**"Why is the rating public?"**
Because a public tally is the product. The contract deliberately discloses it.
Hiding it would remove the value; the privacy goal is the respondent's identity,
not the score.

**"What's that patch in node_modules?"**
A wallet-SDK defect, not contract code. Without it every contract call is
rejected by Preview with ledger error 117. It's version-gated, idempotent,
byte-exactly reversible, and CI proves it never leaks into the v9-era copy.
Full explanation in README §17.

**"Is it deployed?"**
Yes, on Preview:
`916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc`, with a real
`submitFeedback` at block 1084410. Preprod is blocked by the chain until the
ledger-v9 fork, not by this project.

**"Why two contract versions?"**
Midnight is mid-fork and artifacts are era-pinned. The live Preview chain is
still ledger-v8, so the v8 artifact is deployed; the v9 artifact is maintained
in parallel and takes over at the fork.
