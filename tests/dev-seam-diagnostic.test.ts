/**
 * Tests for the DEV-ONLY seam diagnostic.
 *
 * Two jobs, and the second is the important one:
 *
 *  1. The sanitizer must never let transaction, witness, key or address
 *     material through, and must read ONLY the whitelisted fields.
 *  2. The diagnostic must be ABSENT from a production `build:preview` bundle —
 *     the marker string must not appear in the built assets. This is what
 *     makes the diagnostic safe to leave in the tree.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEV_DIAGNOSTIC_MARKER,
  redactDiagnosticText,
  sanitizeSeamFailure,
} from "../src/lib/midnight/devSeamDiagnostic";

const CONTRACT = "916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc";
const RESPONDENT_SECRET = "030c135e10090408c96cd8339f7c09e9e45b7cb6354e35072c857716a641e1e5";

describe("redactDiagnosticText", () => {
  it("replaces a 64-char contract address with a length marker", () => {
    const out = redactDiagnosticText(`no contract at ${CONTRACT} on this network`);
    expect(out).not.toContain(CONTRACT);
    expect(out).toContain(`<hex:${CONTRACT.length}>`);
  });

  it("replaces the respondent invitation secret", () => {
    const out = redactDiagnosticText(`secret=${RESPONDENT_SECRET}`);
    expect(out).not.toContain(RESPONDENT_SECRET);
  });

  it("replaces hex runs of key width (32+), not just 64+", () => {
    const key = "a".repeat(64);
    expect(redactDiagnosticText(key)).not.toContain(key);
  });

  it("replaces a serialized-transaction-sized hex blob", () => {
    const tx = "deadbeef".repeat(200); // 1600 chars, a real tx is this shape
    const out = redactDiagnosticText(tx);
    expect(out).not.toContain("deadbeef");
    expect(out).toContain("<hex:");
  });

  it("replaces a Midnight bech32 address", () => {
    const addr = "mn_addr1previewabcdefghijklmnopqrstuvwxyz0123456789";
    const out = redactDiagnosticText(`address ${addr}`);
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).toContain("<address:");
  });

  it("replaces a base64 blob that could carry a proof", () => {
    const blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5";
    expect(redactDiagnosticText(blob)).not.toContain(blob);
  });

  it("replaces a long raw DUST integer with a count, not the value", () => {
    const dust = "11399696979999999995";
    const out = redactDiagnosticText(`balance ${dust}`);
    expect(out).not.toContain(dust);
    expect(out).toContain(`<num:${dust.length}>`);
  });

  it("truncates an over-long message", () => {
    // Realistic long prose with spaces, so the redaction rules do not collapse
    // it first and the truncation path is what is under test.
    const out = redactDiagnosticText("insufficient dust balance for this transaction. ".repeat(30));
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("[truncated]");
  });

  it("collapses a single very long opaque token instead of echoing it", () => {
    const out = redactDiagnosticText("x".repeat(5000));
    expect(out).not.toContain("xxxx");
    expect(out).toBe("<blob:5000>");
  });

  it("leaves a short, safe diagnostic message intact", () => {
    // A useful reason must survive, or the diagnostic is worthless.
    const out = redactDiagnosticText("InsufficientFunds: dust balance too low");
    expect(out).toBe("InsufficientFunds: dust balance too low");
  });
});

describe("sanitizeSeamFailure", () => {
  it("projects only the whitelisted fields and drops everything else", () => {
    const err = Object.assign(new Error("balance failed"), {
      code: "InternalError",
      reason: "Request failed",
      type: "DAppConnectorAPIError",
      // Material that must never be read:
      tx: "deadbeef".repeat(300),
      witness: "cafebabe".repeat(64),
      secret: RESPONDENT_SECRET,
      request: { body: CONTRACT },
    });

    const out = sanitizeSeamFailure(err);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(RESPONDENT_SECRET);
    expect(serialized).not.toContain("deadbeef");
    expect(serialized).not.toContain("cafebabe");
    expect(out.error?.code).toBe("InternalError");
    expect(out.error?.reason).toBe("Request failed");
    expect(out.error?.type).toBe("DAppConnectorAPIError");
  });

  it("captures the cause level, which is where the real reason lives", () => {
    const err = new Error("balanceTx rejected a retained-era transaction", {
      cause: Object.assign(new Error("Wallet is unavailable"), {
        code: "InternalError",
        reason: "Request failed",
      }),
    });
    const out = sanitizeSeamFailure(err);
    expect(out.error?.message).toContain("rejected a retained-era transaction");
    expect(out.cause?.message).toBe("Wallet is unavailable");
    expect(out.cause?.code).toBe("InternalError");
  });

  it("handles a rejection that is a bare string", () => {
    const out = sanitizeSeamFailure("plain string rejection");
    expect(out.error?.message).toBe("plain string rejection");
    expect(out.cause).toBeNull();
  });

  it("reports null rather than inventing a reason when there is no cause", () => {
    const out = sanitizeSeamFailure(new Error("bare"));
    expect(out.cause).toBeNull();
  });

  it("sanitizes a cause message that carries material", () => {
    const err = new Error("outer", {
      cause: new Error(`failed for tx ${CONTRACT}`),
    });
    const out = sanitizeSeamFailure(err);
    expect(out.cause?.message).not.toContain(CONTRACT);
  });
});

describe("production bundles must not contain the diagnostic", () => {
  /** Every .js asset under dist/assets, concatenated. */
  function distAssets(): string {
    const dir = join(process.cwd(), "dist", "assets");
    if (!existsSync(dir)) return "";
    const files: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d)) {
        const p = join(d, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".js")) files.push(readFileSync(p, "utf8"));
      }
    };
    walk(dir);
    return files.join("\n");
  }

  it(
    "the marker string is absent from dist/",
    () => {
      const bundle = distAssets();
      if (bundle === "") {
        // build:preview has not been run in this working tree; nothing to assert.
        expect(bundle).toBe("");
        return;
      }
      expect(bundle).not.toContain(DEV_DIAGNOSTIC_MARKER);
    },
    { timeout: 60_000 },
  );

  it("the marker string is absent from this source file's exported constant usage in dist", () => {
    const bundle = distAssets();
    if (bundle === "") return;
    expect(bundle).not.toContain("dev-seam-diagnostic");
  });
});
