/**
 * Exit-code verdict for scripts/deploy-preview.mjs.
 *
 * WHY THIS FILE EXISTS
 * The report printed by a deployment run is evidence, not a verdict. A run
 * that deploys, registers, submits and then *silently fails* to finalize a
 * transaction would previously still exit 0. This module is the single place
 * that decides whether a completed run counts as a success, extracted verbatim
 * from the deploy script so it can be exercised by a deterministic, offline
 * test (tests/deploy-verdict.test.ts) without touching Preview, a wallet, a
 * seed or a node.
 *
 * The rules below are intentionally conservative — a missing or unparseable
 * value is a problem, never a pass. `usedNullifiers` in particular is checked
 * as a strict inequality, because "replay protection did not engage" is the
 * single most important thing this deployment has to prove.
 *
 * This module is PURE. It performs no I/O, reads no environment variable,
 * touches no network, and never calls process.exit. Exit-code mapping is
 * exposed separately (verdictExitCode) so it can be asserted directly.
 */

/** Exit code used when the run completed but did not meet the bar. */
export const VERDICT_FAIL_EXIT_CODE = 7;

/** Exit code used when the run met the bar. */
export const VERDICT_PASS_EXIT_CODE = 0;

/**
 * Evaluate a completed deployment report against the final on-chain tally.
 *
 * @param {{ transactions: Array<object>, negativeTests: Array<object> }} report
 * @param {{ responseCount?: number|bigint, usedNullifiers?: number|bigint, surveyOpen?: boolean } | null | undefined} tallyFinal
 * @returns {string[]} human-readable problems; empty array means PASS
 */
export function evaluateVerdict(report, tallyFinal) {
  const problems = [];
  const tally = tallyFinal ?? {};

  for (const t of report?.transactions ?? []) {
    if (t?.ok === false) {
      problems.push(`transaction did not finalize: ${t?.op} (${t?.status ?? "no status"})`);
    }
  }

  for (const n of report?.negativeTests ?? []) {
    if (!n?.pass) {
      problems.push(`negative test was NOT rejected: ${n?.name} -> ${n?.actual}`);
    }
  }

  const submitTx = (report?.transactions ?? []).find((t) => t?.op === "submitFeedback");
  if (!submitTx) {
    problems.push("no submitFeedback transaction was recorded");
  } else if (String(tally.responseCount ?? "0") === "0") {
    problems.push("responseCount is still 0 after submission");
  }

  if (tally.usedNullifiers === undefined || String(tally.usedNullifiers) === "0") {
    problems.push("no nullifier was recorded — replay protection did not engage");
  }

  if (tally.surveyOpen !== true) {
    problems.push("survey did not return to the open state after the close/reopen round-trip");
  }

  return problems;
}

/**
 * Map a problem list to a process exit code. This is the ONLY place the
 * success/failure exit decision is made for a completed deployment run.
 *
 * @param {string[]} problems
 * @returns {number} 0 on PASS, 7 on FAIL
 */
export function verdictExitCode(problems) {
  return Array.isArray(problems) && problems.length === 0 ? VERDICT_PASS_EXIT_CODE : VERDICT_FAIL_EXIT_CODE;
}
