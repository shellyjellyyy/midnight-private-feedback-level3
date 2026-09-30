# How to Use Midnight Private Feedback

This guide is for someone who has never used this dApp before and wants to
either fill out the survey or run the project locally.

> **Network: Preview.** The live deployment is on Midnight **Preview**
> (contract `916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc`).
> Set your wallet to **Preview**, not Preprod and not Mainnet. The Preprod path
> is the current ledger-v9 era and is blocked by the chain until the v9 fork is
> enacted — see README §6.

## What You Need

- The [1AM Wallet](https://1am.money) browser extension (or mobile app with
  its built-in dApp browser), set to the **Preview** network.
- A small amount of test NIGHT on Preview, to pay transaction fees. 1AM can
  request this from the Preview faucet.
- An invite: this survey is only open to respondents who were registered by the
  survey organiser beforehand (see "What Gets Proved" below for why).

## Getting Started

1. Open the deployed demo, or run the app locally with `npm run dev` (see
   README §9 for the Preview-era configuration).
2. You'll see a single card asking you to connect 1AM Wallet, and below it, the
   feedback form itself, disabled until you're connected.

## Connecting 1AM Wallet

1. Click **Connect 1AM Wallet**.
2. Approve the connection request inside the 1AM extension or app.
3. Once approved, your wallet's address appears at the top of the page,
   shortened for readability (e.g. `mn_addr1ab...wxyz`).

If something goes wrong, the app tells you specifically what happened instead
of a generic error:

- **1AM Wallet was not found** — the extension isn't installed, or hasn't
  finished loading yet. Install it from your browser's extension store and
  reload the page.
- **Connection request was declined** — you (or someone) closed or rejected the
  approval prompt in 1AM. Click Connect again when ready.
- **1AM Wallet is set to "X"** — your wallet is pointed at a different network
  than this dApp expects (Preview). Switch it in the wallet's network settings.
- **Could not connect** — a catch-all for anything else (extension crashed,
  browser blocked a popup, etc). Try again; if it persists, restart the browser.

## Using the Core Feature

1. Choose a rating from 1 (very dissatisfied) to 5 (very satisfied).
2. Optionally, type a comment. This box is just for you — see "What Gets
   Proved" below.
3. Click **Submit feedback**.
4. The button and status area walk you through what's happening:
   - *Generating your zero-knowledge proof locally* — your browser is doing the
     cryptographic work of proving you're eligible and haven't answered before,
     without sending your identity anywhere.
   - *Submitting your transaction to Preview* — the proof, along with only the
     information that's meant to be public, is being sent to the network.
   - *Feedback recorded* — done. The public tally now reflects your rating.

You can only submit once. If you try again from the same browser, the app
already knows locally that it holds a spent invite secret; if you somehow tried
again with a fresh copy of the same secret, the contract itself would reject it
via its nullifier check.

## What Gets Proved (and What Does Not)

| | |
|---|---|
| **You prove** | You hold a secret that was registered as an eligible respondent, and you have not submitted feedback before — without saying which registered respondent you are. |
| **Stays private** | Your invite secret. The Merkle path proving your eligibility. Your private state. The plaintext of any comment you wrote. The secret your nullifier is derived from. |
| **Becomes public** | That a feedback transaction happened, and its timing, block and fee. Which rating bucket went up by one — and therefore **your rating**. How many people are registered, how many have responded, whether the survey is open. Your one-time nullifier, and a commitment (hash) to your comment. |

### Please read this part carefully

**Your rating is public.** The contract deliberately discloses it and increments
one of five public counters, so the submitted score is readable on chain. This
is how a public tally works. What is *not* revealed is **which** registered
participant submitted it.

**Your comment's text is not public** — only a hash of it is stored. Nobody can
extract your words from the chain.

**Your transaction is not hidden.** It is an ordinary, fully visible
transaction. If you later want to prove a specific comment was yours, share the
original text with someone and they can hash it and check it against the public
commitment. Nobody can do that without your text.

The honest summary: this is **a publicly observable feedback transaction with
privacy-preserving participant authentication** — the respondent is
unidentified in the ledger's data model, not invisible on the network.

## Troubleshooting

**The submit button stays disabled.** You need to be connected and have picked
a rating first.

**"not a registered respondent for this survey."** Your invite secret hasn't
been added by the organiser yet, or you're using a fresh browser profile that
generated a brand-new (unregistered) secret. Contact the survey organiser.

**"this respondent has already submitted feedback."** Each registered secret can
submit exactly once. If you believe this is wrong, check whether you're using
the same browser you used originally — your invite secret is stored in that
browser's local storage.

**The page says the contract hasn't been compiled.** You're running this locally
before `npm run compile` has been run. See README §9.

**"1AM keeps asking me to switch networks."** Make sure you're on **Preview**,
not Mainnet and not Preprod.

**Submission fails during proving with a DUST balance error.** The Preview
wallet path requires one `node_modules` patch. Run `npm run patch:dust`. See
README §17 for what it does and why.
