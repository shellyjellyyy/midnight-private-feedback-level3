import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
// @ts-ignore - plain ESM helper module, deliberately untyped so it stays importable
// from the deploy script without a build step.
import {
  VERDICT_FAIL_EXIT_CODE,
  VERDICT_PASS_EXIT_CODE,
  evaluateVerdict,
  verdictExitCode,
} from "../scripts/lib-deploy-verdict.mjs";

/**
 * These tests exercise the exit gate of scripts/deploy-preview.mjs OFFLINE.
 *
 * They never touch Preview, a wallet, a seed, a node or a proof server, and
 * they deploy nothing. What they prove is narrower and must be stated exactly:
 * the function that maps a completed deployment report to a process exit code
 * returns 0 for a report that meets the bar and non-zero for one that does
 * not. The gate has NOT been exercised by a live deployment — see README
 * "Negative-test behavior" and the Known Limitations section.
 */

// Resolved from this file, not the CWD, so the test does not depend on where
// vitest was invoked from.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = resolve(REPO_ROOT, "evidence/preview-e2e-20260930.json");
const DEPLOY_SCRIPT = resolve(REPO_ROOT, "scripts/deploy-preview.mjs");

/** The real, recorded report from the verified 2026-09-30 Preview run. */
const verifiedRun = JSON.parse(readFileSync(EVIDENCE, "utf8"));
const verifiedReport = verifiedRun.runReport;
const verifiedFinalTally = verifiedReport.transactions.find(
  (t: { op: string }) => t.op === "final-tally",
).tally;

describe("deploy-preview exit gate — the real verified run PASSES", () => {
  it("reports no problems for the recorded 2026-09-30 Preview evidence", () => {
    expect(evaluateVerdict(verifiedReport, verifiedFinalTally)).toEqual([]);
  });

  it("exits 0 for the recorded 2026-09-30 Preview evidence", () => {
    expect(verdictExitCode(evaluateVerdict(verifiedReport, verifiedFinalTally))).toBe(0);
    expect(verdictExitCode(evaluateVerdict(verifiedReport, verifiedFinalTally))).toBe(
      VERDICT_PASS_EXIT_CODE,
    );
  });
});

describe("deploy-preview exit gate — broken reports FAIL", () => {
  /** Deep clone so each negative case starts from the known-good evidence. */
  const broken = (): { report: any; tally: any } => {
    const report = JSON.parse(JSON.stringify(verifiedReport));
    const tally = JSON.parse(JSON.stringify(verifiedFinalTally));
    return { report, tally };
  };

  it("fails when a positive step did not finalize", () => {
    const { report, tally } = broken();
    report.transactions.find((t: any) => t.op === "submitFeedback").ok = false;
    const problems = evaluateVerdict(report, tally);
    expect(problems).toContainEqual(
      expect.stringContaining("transaction did not finalize: submitFeedback"),
    );
    expect(verdictExitCode(problems)).not.toBe(0);
  });

  it("fails when a negative test was NOT rejected (the exact regression the gate exists for)", () => {
    const { report, tally } = broken();
    report.negativeTests[1].pass = false;
    report.negativeTests[1].actual = "successful-finalized-transaction";
    const problems = evaluateVerdict(report, tally);
    expect(problems).toContainEqual(
      expect.stringContaining("negative test was NOT rejected: invalid-rating-7"),
    );
    expect(verdictExitCode(problems)).not.toBe(0);
  });

  it("fails when no submitFeedback transaction was recorded at all", () => {
    const { report, tally } = broken();
    report.transactions = report.transactions.filter((t: any) => t.op !== "submitFeedback");
    const problems = evaluateVerdict(report, tally);
    expect(problems).toContainEqual("no submitFeedback transaction was recorded");
    expect(verdictExitCode(problems)).not.toBe(0);
  });

  it("fails when responseCount is still 0 after submission", () => {
    const { report, tally } = broken();
    tally.responseCount = "0";
    const problems = evaluateVerdict(report, tally);
    expect(problems).toContainEqual("responseCount is still 0 after submission");
    expect(verdictExitCode(problems)).not.toBe(0);
  });

  it("fails when no nullifier was recorded — replay protection never engaged", () => {
    const { report, tally } = broken();
    tally.usedNullifiers = "0";
    const problems = evaluateVerdict(report, tally);
    expect(problems).toContainEqual(
      "no nullifier was recorded — replay protection did not engage",
    );
    expect(verdictExitCode(problems)).not.toBe(0);
  });

  it("fails when the survey did not return to the open state", () => {
    const { report, tally } = broken();
    tally.surveyOpen = false;
    const problems = evaluateVerdict(report, tally);
    expect(problems).toContainEqual(
      "survey did not return to the open state after the close/reopen round-trip",
    );
    expect(verdictExitCode(problems)).not.toBe(0);
  });

  it("fails on a completely empty report rather than defaulting to success", () => {
    const problems = evaluateVerdict({ transactions: [], negativeTests: [] }, null);
    expect(problems.length).toBeGreaterThan(0);
    expect(verdictExitCode(problems)).toBe(VERDICT_FAIL_EXIT_CODE);
  });

  it("maps every non-empty problem list to a non-zero exit code", () => {
    expect(verdictExitCode(["x"])).toBe(VERDICT_FAIL_EXIT_CODE);
    expect(verdictExitCode(["x"])).not.toBe(0);
    expect(verdictExitCode(undefined)).toBe(VERDICT_FAIL_EXIT_CODE);
  });
});

describe("deploy-preview.mjs contains no unconditional success exit", () => {
  const source = readFileSync(DEPLOY_SCRIPT, "utf8");

  it("has no bare `process.exit(0)` outside the --fund-status early-return", () => {
    // The ONLY permitted `process.exit(0)` is inside the fund-status branch,
    // which prints addresses and returns before any deployment work happens.
    const occurrences = [...source.matchAll(/process\.exit\(0\)/g)];
    for (const occurrence of occurrences) {
      const start = Math.max(0, occurrence.index - 1500);
      expect(source.slice(start, occurrence.index)).toContain("FUND_STATUS_MODE");
    }
    expect(occurrences.length).toBeLessThanOrEqual(1);
  });

  it("routes the final exit through verdictExitCode, not a literal", () => {
    expect(source).toContain("process.exit(verdictExitCode(problems))");
    expect(source).not.toContain("process.exit(problems.length === 0 ? 0 : 7)");
  });

  it("exits non-zero on an unhandled fatal error", () => {
    expect(source).toContain("process.exit(1)");
  });
});
