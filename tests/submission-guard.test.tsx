/**
 * Regression test for the state-propagation bug between a successful 1AM
 * connect and the feedback submission guard.
 *
 * Symptom: the wallet card rendered "1AM Wallet connected", the rating and
 * comment fields were enabled, and pressing Submit answered "Connect 1AM
 * Wallet before submitting."
 *
 * Cause: `useMidnight`'s submit guard requires BOTH `wallet.status ===
 * "connected"` AND a non-null `connectedApi`. `connect()` stored the wallet
 * state but never stored the `ConnectedAPI`, so the second half of the guard
 * stayed false forever. Only the `wallet` half is reflected in the UI, which
 * is why the two disagreed.
 *
 * This drives the real hook with a real React state transition — the injected
 * wallet is a stub only because there is no browser extension in jsdom — and
 * asserts the guard agrees with the wallet card after connect resolves.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useMidnight } from "../src/hooks/useMidnight";
import { EXPECTED_NETWORK_ID } from "../src/lib/midnight/era";
import type { ConnectedAPI, InitialAPI } from "../src/lib/wallet";

// React 18 reads this flag; without it `act` warns and updates may not flush.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Mirrors the submit guard in useMidnight.submitFeedback. */
type GuardInput = { wallet: { status: string }; connectedApi: ConnectedAPI | null };
const submitGuardRefuses = ({ wallet, connectedApi }: GuardInput) =>
  wallet.status !== "connected" || !connectedApi;

function installWallet(api: ConnectedAPI) {
  const wallet: InitialAPI = {
    name: "1AM Wallet",
    icon: "data:image/png;base64,",
    apiVersion: "4.0.1",
    connect: vi.fn().mockResolvedValue(api),
  };
  (window as unknown as { midnight: Record<string, unknown> }).midnight = { "1am-key": wallet };
}

/**
 * Renders useMidnight and records, after every state change, whether the
 * submission guard would accept the current wallet/connectedApi pair.
 */
function renderHook() {
  const observed: Array<{ walletStatus: string; connectedApiPresent: boolean; refused: boolean }> = [];

  function Probe() {
    const { wallet, connectedApi, connect, disconnect } = useMidnight();
    useEffect(() => {
      observed.push({
        walletStatus: wallet.status,
        connectedApiPresent: connectedApi !== null,
        refused: submitGuardRefuses({ wallet, connectedApi }),
      });
    }, [wallet, connectedApi]);
    // Exposed so the test can trigger real transitions on this instance.
    const handle = globalThis as unknown as { __hook?: Pick<typeof hookResult, "connect" | "disconnect"> };
    handle.__hook = { connect, disconnect };
    return null;
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
  });
  return { observed, hook: () => (globalThis as unknown as { __hook: typeof hookResult }).__hook };
}

type hookResult = ReturnType<typeof useMidnight>;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  (globalThis as unknown as { __hook?: unknown }).__hook = undefined;
  (window as unknown as { midnight?: unknown }).midnight = undefined;
});

describe("feedback submission guard after connecting 1AM Wallet", () => {
  it("refuses while disconnected, then accepts once the wallet connects", async () => {
    const api = {
      getConfiguration: vi.fn().mockResolvedValue({ networkId: EXPECTED_NETWORK_ID }),
      getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: "mn_addr1live" }),
    } as unknown as ConnectedAPI;
    installWallet(api);

    const { observed, hook } = renderHook();

    // Before any connection attempt the guard must refuse.
    const initial = observed[observed.length - 1];
    expect(initial.walletStatus).toBe("disconnected");
    expect(initial.connectedApiPresent).toBe(false);
    expect(initial.refused).toBe(true);

    await act(async () => {
      hook().connect();
    });

    // THE REGRESSION: the wallet card shows "connected", so the guard must not
    // still be refusing — previously connectedApi stayed null here.
    const final = observed[observed.length - 1];
    expect(final.walletStatus).toBe("connected");
    expect(final.connectedApiPresent).toBe(true);
    expect(final.refused).toBe(false);
  });

  it("clears the connected API again on disconnect", async () => {
    const api = {
      getConfiguration: vi.fn().mockResolvedValue({ networkId: EXPECTED_NETWORK_ID }),
      getUnshieldedAddress: vi.fn().mockResolvedValue({ unshieldedAddress: "mn_addr1live" }),
    } as unknown as ConnectedAPI;
    installWallet(api);

    const { observed, hook } = renderHook();
    await act(async () => {
      hook().connect();
    });
    expect(observed[observed.length - 1].refused).toBe(false);

    await act(async () => {
      hook().disconnect();
    });

    const final = observed[observed.length - 1];
    expect(final.walletStatus).toBe("disconnected");
    expect(final.connectedApiPresent).toBe(false);
    expect(final.refused).toBe(true);
  });
});