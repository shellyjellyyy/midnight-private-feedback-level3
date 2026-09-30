# Product Proposal — Midnight Private Feedback

**A zero-knowledge survey platform: organisations get a verifiable aggregate
tally, respondents get a cryptographic guarantee that their feedback cannot be
tied to their identity.**

> **Status of the claims in this document.** This project has been built and
> deployed to a public test network. It has **not** been fielded with real
> users, and no user research, adoption data or usage metrics exist. Nothing
> below is presented as validated market demand.

---

## 1. Problem

Feedback is the cheapest way to find out what people actually think and the
easiest thing to stop people from giving honestly.

The blocker is rarely the survey platform. It is the identity trail around it.
A survey link emailed from an HR system produces a response record that the
sender can read: who answered, when, from where, and often from which browser.
Once that link exists, respondents are correct to assume the feedback is
attributable, and they either answer strategically or not at all.

Three specific failure modes recur:

1. **Identifiability suppresses candour.** People soften negative feedback when
   they believe it can be traced to them. The result is a survey that
   systematically over-reports satisfaction — precisely the failure mode an
   organisation most needs to detect.
2. **Free text is the highest-risk field.** Even when ratings are aggregated,
   verbatim comments are trivially re-identifiable through writing style,
   project context and named colleagues. Aggregating the number does not
   anonymise the sentence.
3. **Eligibility and single-use are enforced by the identity system.** "One
   response per person" is normally enforced with a login or an email list —
   reintroducing exactly the link the process was meant to avoid.

These are not policy problems. They are cryptographic problems, and they cannot
be solved by being careful with application code.

## 2. Target users

| Segment | Why anonymity is the binding constraint |
|---|---|
| **HR and internal pulse surveys** | Employees rate their own management. Attributable answers are not honest answers, and the reputational cost of a leak is highest here. |
| **Compliance and safety reporting** | Reporting misconduct is the clearest case where the reporter's identity is a deterrent to participation. |
| **Community operators** | DAOs, open-source maintainers and event organisers want representative sentiment without a roster attached to it. |
| **Clinical / educational feedback** | Where honest reporting is a precondition for the process having value at all. |

Common thread: the organiser needs the *aggregate*; the respondent needs the
*non-attribution*. Conventional tools force a choice between the two.

## 3. Proposed product

A browser dApp plus a Compact smart contract. The organiser deploys a survey
contract and publishes a survey link. Respondents connect a Midnight wallet and
submit one 1–5 rating plus an optional free-text comment. Eligibility and
single participation are enforced by the contract, not by a login.

The organiser gets a public, independently verifiable tally. The respondent
gets a proof that they were eligible and had not already answered, without
revealing which registered participant they are.

**Deployed and verified today:** Midnight Preview, contract
`916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc`, with a real
`submitFeedback` transaction finalizing `SucceedEntirely` at block 1084410
(2026-09-30) and an independent re-verification from the indexer.

## 4. Why privacy matters

Anonymity in feedback is not a nice-to-have; it is the difference between a
signal and noise. An organisation that cannot trust its own survey data makes
worse decisions while believing it is making better ones, because the
attrition is invisible — you do not see the people who declined to answer, only
the people who felt safe answering.

Making the guarantee cryptographic rather than policy-based also changes the
trust conversation. The organiser does not have to be trusted: the contract's
assertions are public, and anyone can read the ledger. Privacy and integrity
stop being competing requirements.

## 5. How Midnight enables it

Midnight is the only reason this is buildable at reasonable effort, for three
specific reasons:

1. **Compact expresses the whole rule in one place.** Eligibility, single-use,
   rating range and admin authorisation are all circuit assertions. There is no
   off-chain validation layer to bypass and no admin database to leak — the
   privacy property is a property of the contract, not of a policy.
2. **Private witnesses are a language feature, not a workaround.** The invite
   secret, the Merkle path and the comment are private inputs. They are never
   serialised, never transmitted, and never appear in a trace.
3. **Selective disclosure is available where it is needed.** `disclose()` lets
   the design publish the rating and the counters while keeping the identity
   link hidden. A system where everything is either public or secret could not
   produce a public tally with an unidentifiable author.

Midnight's UTXO-based shielded state is a reasonable future home for
comment content as well: the commit–reveal design here would become a genuine
private channel rather than a public hash.

## 6. Core user flow

**Respondent (≈60 seconds):**

1. Opens the survey link.
2. Clicks **Connect** and approves in their Midnight wallet.
3. Picks a rating 1–5; optionally types a comment.
4. Clicks **Submit**. The browser generates the ZK proof locally.
5. The transaction finalizes. The public tally updates.

The respondent's secret, Merkle path and comment plaintext never leave the
browser. The rating and the response are public. The link between them is not.

**Organiser:**

1. Deploys the contract with a generated admin commitment.
2. Registers eligible respondents by publishing a commitment to each invite
   secret, distributing those secrets out of band.
3. Publishes the survey link.
4. Reads the public tally, and can verify it independently against the chain.

## 7. Privacy model

**Private:** the invite secret; the Merkle path witness; the private state; the
comment plaintext; the admin secret; the secret the nullifier is derived from.

**Public and observable:** the contract address; whether the survey is open;
how many participants are registered; how many have responded; the public
rating tally; the nullifier set (required for duplicate prevention); comment
commitments; all transaction and block metadata; and the fact that a response
occurred.

**The rating is public by design.** The contract deliberately discloses it and
increments one of five counters. This is stated plainly rather than glossed
over, because it is the most common over-claim in this category.

**The guarantee:** the ledger's data model does not link a response to a
registered commitment.

**The limit:** the transaction is not invisible, and the guarantee does not
defend against an adversary who can correlate accounts, IP addresses and timing
outside the chain. The accurate description is *a publicly observable feedback
transaction with privacy-preserving participant authentication* — not
"anonymous" in the sense of invisible.

## 8. MVP scope — shipped

- Compact survey contract: registration, open/close, submission, admin gating.
- Merkle eligibility proof with path-to-secret binding (regression-tested
  against the specific attack it prevents).
- Contract-scoped nullifier replay protection and cross-survey unlinkability.
- In-circuit rating validation before any public state moves.
- Commit–reveal comment channel.
- Browser dApp: wallet connection, survey state, rating and comment entry,
  live public tally.
- Dual-era toolchain with a CI-enforced separation guarantee.
- Deployed and verified end-to-end on a public test network.

## 9. Future features

Ordered by value, not by ease.

1. **Multi-question surveys and configurable scales.** The immediate gap
   between the demo and real use.
2. **Result commitment and delayed publication.** The organiser commits to a
   hash of the final tally up front and reveals it later, so they cannot
   quietly change reported numbers. This protects respondents from organiser
   misreporting, not just from organiser surveillance.
3. **A survey factory** that deploys a fresh contract per survey. This also
   makes the contract-scoped nullifier property tangible rather than
   theoretical, since users would see the scope differ between surveys.
4. **Consent-gated comment analysis.** Clustering over voluntarily revealed
   comments, with an explicit per-respondent consent step — never inference
   from undisclosed text.
5. **Credential-based eligibility.** Proofs of "I am over 18" or "I attended
   this session" without disclosing *which* attendee, generalising the
   one-secret-per-person model.
6. **Shielded comments.** Move comment content into Midnight's shielded state,
   so comments are private by default with selective disclosure rather than
   public-by-hash.
7. **On-chain result retrieval** through the public data provider, so any third
   party can verify a survey's outcome without trusting the organiser.

## 10. Risks and limitations

| Risk | Assessment |
|---|---|
| **The rating is public.** Removes the most common objection to anonymous feedback. | Accepted as a deliberate trade-off. The privacy claim is narrowed to the respondent's identity, and stated explicitly rather than glossed. |
| **Correlation attacks at the network layer.** | Out of scope of the ZK guarantee. Partially mitigable by shielded-state submission in future work, not solved here. |
| **Trusted admin role.** A malicious organiser can register arbitrary commitments and open/close at will. | Accepted for MVP. Result commitment (future #2) is the mitigation. |
| **Secret compromise.** If a participant's secret leaks, their commitment and nullifier become attributable to them. | Documented; requires treating the secret as long-lived key material. |
| **Single admin, no key rotation.** `adminAddress` is fixed at construction; losing the admin secret loses admin authority permanently. | Accepted for MVP. |
| **Live path depends on a patched wallet SDK** until the v9 toolchain is deployable. | The patch is version-gated, idempotent, byte-exactly reversible, era-safe and CI-verified. It is a dependency defect, not contract code. |
| **Preprod/v9 path is blocked by the chain**, not by this project. | A verified, reproducible chain-era fact. The v9 artifact is maintained in parallel. |
| **Organiser UX for distributing secrets out of band is unsolved.** | Currently manual. This is the largest practical friction point in the current design. |
| **No field evidence.** | No user research, no adoption data, no measured response-rate uplift. Any such claim would be fabricated. |

## 11. Success metrics

**What would be measured, if deployed:**

- Surveys deployed per month.
- Unique participants submitting at least one response, per survey.
- Response rate as a fraction of issued invitations — the metric that would
  actually test the central hypothesis, that anonymity increases participation.
- Organiser-reported trust in their own survey results.

**Current status: none of these have been measured.** The project has been
built and verified on a public test network by a single development effort,
with no field deployment and no users. The central hypothesis — that
cryptographic anonymity raises response rates and candour — is a design
rationale, not a measured result, and this document does not claim otherwise.
