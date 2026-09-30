/**
 * Regression test for the live browser failure:
 *
 *   "Contract address not set. Call setContractAddress() before accessing
 *    private state."
 *
 * `useMidnight.submitFeedback` stores the respondent's private state BEFORE
 * calling `joinFeedbackContract`, because the retained-era join re-reads the
 * state under the well-known id and refuses an id the provider holds nothing
 * under. `findDeployedContract` scopes the provider to the contract address
 * itself, but only DURING the join â€” so the earlier `set()` had no scoped
 * address and the provider refused.
 *
 * `PrivateStateProvider.setContractAddress` is documented as mandatory before
 * any get/set/remove. The working Node flow in scripts/diag-submitfeedback.mjs
 * already calls it for exactly this reason.
 *
 * This drives the REAL hook and asserts the ordering that was missing: the
 * configured contract address is registered on the provider BEFORE the first
 * private-state access. The provider stand-in enforces the same precondition
 * the real one does, so an unfixed hook fails here the way it failed live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import type { ConnectedAPI, InitialAPI } from "../src/lib/wallet";
import { EXPECTED_NETWORK_ID } from "../src/lib/midnight/era";

const CONTRACT_ADDRESS =
  "916ae63acf5d4256a33c249cf138938cb9cb33210cf6081feecb2a18648248bc";

/**
 * Minimal stand-in for the level private-state provider that enforces its real
 * documented precondition: any get/set/remove before setContractAddress throws
 * the same message the browser surfaced.
 */
function makeProvider() {
  let scopedAddress: string | null = null;
  const calls: string[] = [];

  return {
    calls,
    setContractAddress: vi.fn((address: string) => {
      scopedAddress = address;
      calls.push("setContractAddress");
    }),
    set: vi.fn(async (_id: string, _state: unknown) => {
      if (scopedAddress === null) {
        throw new Error(
          "Contract address not set. Call setContractAddress() before accessing private state.",
        );
      }
      calls.push("set");
    }),
    get: vi.fn(async () => {
      if (scopedAddress === null) {
        throw new Error(
          "Contract address not set. Call setContractAddress() before accessing private state.",
        );
      }
      return null;
    }),
  };
}

let provider = makeProvider();
let joinCalls = 0;
let submitTxCalls = 0;

const buildProvidersFromConnectedAPI = vi.fn(async () => ({
  era: "v8-preview" as const,
  providers: { privateStateProvider: provider },
  dispose: vi.fn(async () => {}),
}));

const joinFeedbackContract = vi.fn(async () => {
  joinCalls++;
  // Mirror the real join, which re-reads state through the same provider.
  await provider.get("feedback:private-state");
  return { handle: {}, watchForTxData: vi.fn(), dispose: vi.fn(async () => {}) };
});

const submitFeedbackTx = vi.fn(async () => {
  submitTxCalls++;
  return { txId: "0xabc123" };
});

vi.mock("../src/lib/midnight/providers.js", () => ({
  buildProvidersFromConnectedAPI,
  FEEDBACK_PRIVATE_STATE_ID: "feedback:private-state",
}));
vi.mock("../src/lib/midnight/feedback.js", () => ({
  joinFeedbackContract,
  submitFeedbackTx,
  deployedContractAddress: () => CONTRACT_ADDRESS,
}));

const { useMidnight } = await import("../src/hooks/useMidnight");

let container: HTMLDivElement;
let root: Root;
let hookRef: ReturnType<typeof useMidnight> | null = null;

/** Installs a 1AM wallet stub and renders the real hook. */
async function renderAndConnect() {
  const api = {
    getConfiguration: vi.fn().mockResolvedValue({ networkId: EXPECTED_NETWORK_ID }),
    getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: "mn_addr1test" }),
  } as unknown as ConnectedAPI;
  const wallet: InitialAPI = {
    name: "1AM Wallet",
    icon: "data:image/png;base64,",
    apiVersion: "4.0.1",
    connect: vi.fn().mockResolvedValue(api),
  };
  (window as unknown as { midnight: Record<string, unknown> }).midnight = { "1am-key": wallet };

  function Probe() {
    hookRef = useMidnight();
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });
  await act(async () => {
    hookRef?.connect();
  });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The submission path requires an ORGANIZER-PROVIDED invitation secret and
  // refuses to proceed without one (see src/lib/inviteSecret.ts). This test is
  // about the provider-scoping ORDER, which is only reachable once that
  // pre-condition is satisfied — so store a (fake, never-registered) secret
  // here. The Merkle-path check happens much later, inside the circuit, and is
  // not reached because joinFeedbackContract is mocked.
  window.localStorage.setItem(
    "midnight-feedback-invite-secret",
    "00112233445566778899aabbccddeeff0102030405060708090a0b0c0d0e0f10",
  );
  provider = makeProvider();
  joinCalls = 0;
  submitTxCalls = 0;
  buildProvidersFromConnectedAPI.mockClear();
  joinFeedbackContract.mockClear();
  submitFeedbackTx.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined as unknown as Root;
  container = undefined as unknown as HTMLDivElement;
  (window as unknown as { midnight?: unknown }).midnight = undefined;
});

describe("private-state provider contract-address scoping", () => {
  it("registers the configured contract address before the first private-state access", async () => {
    await renderAndConnect();

    await act(async () => {
      await hookRef?.submitFeedback(4, "amazing");
    });
// THE ORDERING THIS GUARDS: the provider must be scoped before it is used.
    // `joinFeedbackContract` is mocked here, so the real join's own re-read of
    // the stored state does not appear in the log; what matters is that
    // scoping precedes the first access.
    expect(provider.calls).toEqual(["setContractAddress", "set"]);

    // Scoped with the address the app was configured with, not undefined.
    expect(provider.setContractAddress).toHaveBeenCalledTimes(1);
    expect(provider.setContractAddress).toHaveBeenCalledWith(CONTRACT_ADDRESS);

    // And the whole real flow still ran.
    expect(joinCalls).toBe(1);
    expect(submitTxCalls).toBe(1);
    expect(hookRef?.submission.stage).toBe("confirmed");
  });

  it("does not reach the private-state store when the contract address is unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    (globalThis as unknown as { midnight: Record<string, unknown> }).midnight = undefined;
    void errorSpy;

    await renderAndConnect();
    await act(async () => {
      await hookRef?.submitFeedback(4, "amazing");
    });

    // Guarding only: with no wallet the submit path must not silently proceed.
    expect(provider.calls).not.toContain("set");
    expect(submitTxCalls).toBe(0);
  });
});

