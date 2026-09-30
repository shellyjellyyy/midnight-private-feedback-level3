import { LogOut, Wallet } from "lucide-react";
import {
  listAvailableWallets,
  shortenAddress,
  WALLET_LABELS,
  type WalletConnectionState,
  type WalletKind,
} from "../lib/wallet";
import { StatusMessage } from "./StatusMessage";

interface WalletConnectProps {
  wallet: WalletConnectionState;
  onConnect: (kind: WalletKind) => void;
  onDisconnect: () => void;
}

/**
 * The wallets offered, in display order. The connected wallet's own label is
 * reported from the live connection state, so a card can never claim the wrong
 * wallet is attached.
 */
const OFFERED: WalletKind[] = ["1am", "lace"];

export function WalletConnect({ wallet, onConnect, onDisconnect }: WalletConnectProps) {
  if (wallet.status === "connected") {
    return (
      <div className="wallet-card wallet-card-connected">
        <div className="wallet-card-row">
          <Wallet size={18} aria-hidden="true" />
          <div>
            <p className="wallet-label">{WALLET_LABELS[wallet.walletKind]} connected</p>
            <p className="wallet-address">{shortenAddress(wallet.address)}</p>
          </div>
        </div>
        <button type="button" className="button button-ghost" onClick={onDisconnect}>
          <LogOut size={16} aria-hidden="true" />
          Disconnect
        </button>
      </div>
    );
  }

  if (wallet.status === "connecting") {
    return (
      <div className="wallet-card">
        <StatusMessage kind="pending">Waiting for approval in your wallet...</StatusMessage>
      </div>
    );
  }

  // Which wallets are actually injected. Extensions inject slightly after
  // DOMContentLoaded, so this is read on every render rather than cached.
  const available = listAvailableWallets();
  const nothingInstalled = available.length === 0;

  return (
    <div className="wallet-card">
      {wallet.status === "error" && <StatusMessage kind="error">{wallet.message}</StatusMessage>}
      {OFFERED.map((kind) => (
        <button
          key={kind}
          type="button"
          className="button button-primary"
          onClick={() => onConnect(kind)}
        >
          <Wallet size={16} aria-hidden="true" />
          Connect {WALLET_LABELS[kind]}
        </button>
      ))}
      <p className="wallet-hint">
        Either wallet works. The connected wallet pays the transaction fee from its own
        DUST balance, and the invitation secret is what grants eligibility.
      </p>
      {nothingInstalled && (
        <p className="wallet-hint">
          No Midnight wallet detected. Install 1AM Wallet or Lace from your browser's
          extension store, then reload this page.
        </p>
      )}
    </div>
  );
}
