/**
 * Respondent-side invitation-secret import: storage, validation, UX truthfulness.
 *
 * THE BEHAVIOUR UNDER TEST
 *   The browser must never silently mint an unregistered secret. An
 *   organizer-provided secret is imported, validated strictly, stored under the
 *   pre-existing localStorage key, and never surfaced to diagnostics/logs.
 *
 * Uses react-dom/client + act directly (the convention established by
 * tests/private-state-scoping.test.tsx) rather than @testing-library/react,
 * which is not a dependency of this project.
 *
 * NO NETWORK. Nothing here contacts Preview or any server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { InviteSecretImport } from "../src/components/InviteSecretImport";
import {
  INVITE_SECRET_STORAGE_KEY,
  clearStoredInviteSecret,
  hasStoredInviteSecret,
  importInviteSecret,
  readStoredInviteSecret,
} from "../src/lib/inviteSecret";

const VALID_SECRET = "00112233445566778899aabbccddeeff0102030405060708090a0b0c0d0e0f10";

/** Mounts a component into a real DOM container and returns its root + container. */
async function mount(element: React.ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return { root, container };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// 1. Validation and storage.
// ---------------------------------------------------------------------------

describe("invite secret import", () => {
  it("accepts a valid 32-byte hex secret and stores it under the existing key", () => {
    const secret = importInviteSecret(VALID_SECRET);

    expect(secret).toHaveLength(32);
    expect(window.localStorage.getItem(INVITE_SECRET_STORAGE_KEY)).toBe(VALID_SECRET);
    // The key is the pre-existing one, unchanged, so a respondent who already
    // stored a secret keeps working.
    expect(INVITE_SECRET_STORAGE_KEY).toBe("midnight-feedback-invite-secret");
  });

  it("returns the same bytes it persisted", () => {
    const stored = importInviteSecret(VALID_SECRET);
    const read = readStoredInviteSecret();
    expect(Array.from(read!)).toEqual(Array.from(stored));
  });

  it("rejects invalid secrets", () => {
    // None of these may be stored.
    const bad = [
      "",
      "deadbeef", // too short
      "z".repeat(64), // not hex
      `${VALID_SECRET}ab`, // 33 bytes
      VALID_SECRET.slice(0, 62), // 31 bytes
      " ".repeat(64), // whitespace only
    ];
    for (const value of bad) {
      expect(() => importInviteSecret(value)).toThrow();
      expect(window.localStorage.getItem(INVITE_SECRET_STORAGE_KEY)).toBeNull();
    }
  });

  it("a rejected paste does not destroy an already-good stored secret", () => {
    importInviteSecret(VALID_SECRET);
    expect(() => importInviteSecret("not-a-secret")).toThrow();
    // The good secret survives — a typo cannot poison later submissions.
    expect(window.localStorage.getItem(INVITE_SECRET_STORAGE_KEY)).toBe(VALID_SECRET);
  });

  it("normalizes case and an 0x prefix to the canonical stored form", () => {
    importInviteSecret(`0x${VALID_SECRET.toUpperCase()}`);
    expect(window.localStorage.getItem(INVITE_SECRET_STORAGE_KEY)).toBe(VALID_SECRET);
  });

  it("hasStoredInviteSecret reflects presence without exposing the value", () => {
    expect(hasStoredInviteSecret()).toBe(false);
    importInviteSecret(VALID_SECRET);
    expect(hasStoredInviteSecret()).toBe(true);
    // The predicate is a boolean, never the secret.
    expect(typeof hasStoredInviteSecret()).toBe("boolean");
  });

  it("treats a corrupted stored value as absent rather than crashing", () => {
    window.localStorage.setItem(INVITE_SECRET_STORAGE_KEY, "corrupted-not-hex");
    expect(hasStoredInviteSecret()).toBe(false);
    expect(readStoredInviteSecret()).toBeNull();
  });

  it("clearStoredInviteSecret removes it", () => {
    importInviteSecret(VALID_SECRET);
    clearStoredInviteSecret();
    expect(window.localStorage.getItem(INVITE_SECRET_STORAGE_KEY)).toBeNull();
    expect(hasStoredInviteSecret()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Nothing leaks the secret.
// ---------------------------------------------------------------------------

describe("secret is never logged or exposed", () => {
  it("importInviteSecret does not log the secret", () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];
    importInviteSecret(VALID_SECRET);
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(VALID_SECRET);
      }
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("a rejected import's error message does not contain the pasted value", () => {
    try {
      importInviteSecret("z".repeat(64));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("zzzz");
    }
  });

  it("redactDeep withholds any field whose NAME denotes a secret", async () => {
    // A bare 64-hex value is indistinguishable from the public contract
    // address, so redaction works by field NAME, not by shape. This asserts
    // every secret-shaped name is withheld, at any depth, including in arrays.
    const { redactDeep } = await import("../src/lib/midnight/diagnostics");
    const hex = VALID_SECRET;

    const out = JSON.stringify(
      redactDeep({
        secret: hex,
        inviteSecret: hex,
        privateState: hex,
        seed: hex,
        password: hex,
        nested: { secret: hex, deep: { invite_secret: hex } },
        list: [{ secret: hex }],
      }),
    );

    expect(out).not.toContain(hex);
    expect(out).toContain("<withheld>");
  });

  it("still preserves public values the diagnostics exist to report", async () => {
    // The redaction must not be so aggressive that it destroys the contract
    // address and network id it was built to surface.
    const { redactDeep } = await import("../src/lib/midnight/diagnostics");
    const CONTRACT = "916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc";
    const out = redactDeep({ contractAddress: CONTRACT, networkId: "preview", era: "v8-preview" });
    expect(out).toEqual({ contractAddress: CONTRACT, networkId: "preview", era: "v8-preview" });
  });

  it("no production caller passes the invite secret into diagnostics", async () => {
    // Static guard: no source file may hand the stored secret to a diagnostic.
    // The secret reaches exactly one consumer — the submitFeedback witness.
    const { readFileSync, readdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const srcDir = resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const text = readFileSync(full, "utf8");
        // Any file that both reads the secret and reports a diagnostic is suspect.
        if (/readStoredInviteSecret|importInviteSecret/.test(text) && /report[A-Z]\w*\(/.test(text)) {
          offenders.push(full);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it("no source file references the storage key outside inviteSecret.ts", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const srcDir = resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const text = readFileSync(full, "utf8");
        if (text.includes("midnight-feedback-invite-secret") && !full.endsWith("inviteSecret.ts")) {
          offenders.push(full);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The import UI (real DOM, no testing-library).
// ---------------------------------------------------------------------------

describe("InviteSecretImport UI", () => {
  const findInput = (container: HTMLElement): HTMLInputElement => {
    const input = container.querySelector("input");
    if (!input) throw new Error("no input rendered");
    return input as HTMLInputElement;
  };
  const buttons = (container: HTMLElement): HTMLButtonElement[] =>
    Array.from(container.querySelectorAll("button"));
  const buttonNamed = (container: HTMLElement, re: RegExp): HTMLButtonElement => {
    const found = buttons(container).find((b) => re.test(b.textContent ?? ""));
    if (!found) throw new Error(`no button matching ${re}`);
    return found;
  };

  it("offers an import field and saves a valid secret", async () => {
    const onChange = vi.fn();
    const { container } = await mount(<InviteSecretImport onChange={onChange} />);

    const input = findInput(container);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, VALID_SECRET);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      buttonNamed(container, /save invitation secret/i).click();
    });

    expect(window.localStorage.getItem(INVITE_SECRET_STORAGE_KEY)).toBe(VALID_SECRET);
    // Only a boolean crosses the component boundary.
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("masks the secret while it is typed", async () => {
    const { container } = await mount(<InviteSecretImport />);
    const input = findInput(container);
    expect(input.type).toBe("password");
    // Spellcheck/autocomplete off, so the secret is not retained by the browser.
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
  });

  it("does not leave the secret in the DOM after import", async () => {
    const { container } = await mount(<InviteSecretImport />);
    const input = findInput(container);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, VALID_SECRET);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      buttonNamed(container, /save invitation secret/i).click();
    });

    // The field is cleared, so the secret is not sitting in the document.
    expect(findInputOrNull(container)?.value ?? "").toBe("");
    expect(document.body.innerHTML).not.toContain(VALID_SECRET);
  });

  it("shows an error and stores nothing for an invalid secret", async () => {
    const onChange = vi.fn();
    const { container } = await mount(<InviteSecretImport onChange={onChange} />);
    const input = findInput(container);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "nope");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      buttonNamed(container, /save invitation secret/i).click();
    });

    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    expect(window.localStorage.getItem(INVITE_SECRET_STORAGE_KEY)).toBeNull();
    expect(onChange).not.toHaveBeenCalledWith(true);
  });

  it("never offers to generate a secret", async () => {
    const { container } = await mount(<InviteSecretImport />);
    // A self-minted secret can never pass the Merkle-path check, so there must
    // be no generate/auto-create affordance anywhere in the UI.
    const generateButton = buttons(container).find((b) => /generate/i.test(b.textContent ?? ""));
    expect(generateButton).toBeUndefined();
    expect(container.innerHTML).not.toMatch(/generate/i);
  });

  it("shows the stored state and a way to forget it once imported", async () => {
    const onChange = vi.fn();
    const { container } = await mount(<InviteSecretImport onChange={onChange} />);
    const input = findInput(container);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, VALID_SECRET);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      buttonNamed(container, /save invitation secret/i).click();
    });

    const forget = buttonNamed(container, /forget this invitation/i);
    // The secret itself is never rendered.
    expect(document.body.innerHTML).not.toContain(VALID_SECRET);

    await act(async () => {
      forget.click();
    });
    expect(window.localStorage.getItem(INVITE_SECRET_STORAGE_KEY)).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("reflects an already-stored secret on mount (no silent regeneration)", async () => {
    importInviteSecret(VALID_SECRET);
    const { container } = await mount(<InviteSecretImport />);
    // No input field is offered — the stored invitation is in use.
    expect(container.querySelector("input")).toBeNull();
    expect(document.body.innerHTML).not.toContain(VALID_SECRET);
  });
});

function findInputOrNull(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector("input") as HTMLInputElement | null;
}

// ---------------------------------------------------------------------------
// 4. No silent generation, and the submit path requires a provisioned secret.
// ---------------------------------------------------------------------------

describe("no-secret submission is refused truthfully", () => {
  it("a fresh browser has no auto-generated secret", () => {
    // The critical regression: the previous implementation minted a random
    // secret on first use, guaranteeing an unregistered failure.
    expect(window.localStorage.getItem(INVITE_SECRET_STORAGE_KEY)).toBeNull();
    expect(hasStoredInviteSecret()).toBe(false);
    // Reading must NOT create one.
    readStoredInviteSecret();
    hasStoredInviteSecret();
    expect(window.localStorage.getItem(INVITE_SECRET_STORAGE_KEY)).toBeNull();
  });

  it("importInviteSecret is the only writer of the storage key", () => {
    // Two imports -> still exactly one key/value, no side files.
    importInviteSecret(VALID_SECRET);
    importInviteSecret(VALID_SECRET);
    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.key(0)).toBe(INVITE_SECRET_STORAGE_KEY);
  });
});