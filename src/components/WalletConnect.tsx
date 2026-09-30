import { Loader2, LogOut, Wallet } from "lucide-react";
import { shortenAddress, type WalletConnectionState } from "../lib/wallet";
import { StatusMessage } from "./StatusMessage";

interface WalletConnectProps {
  wallet: WalletConnectionState;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function WalletConnect({ wallet, onConnect, onDisconnect }: WalletConnectProps) {
  if (wallet.status === "connected") {
    return (
      <div className="wallet-card wallet-card-connected">
        <div className="wallet-card-row">
          <Wallet size={18} aria-hidden="true" />
          <div>
            <p className="wallet-label">1AM Wallet connected</p>
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
        <StatusMessage kind="pending">Waiting for approval in 1AM Wallet...</StatusMessage>
      </div>
    );
  }

  return (
    <div className="wallet-card">
      {wallet.status === "error" && <StatusMessage kind="error">{wallet.message}</StatusMessage>}
      <button type="button" className="button button-primary" onClick={onConnect}>
        <Wallet size={16} aria-hidden="true" />
        Connect 1AM Wallet
      </button>
      {wallet.status === "error" && wallet.reason === "not-installed" && (
        <p className="wallet-hint">
          Don't have it yet? Install 1AM Wallet from your browser's extension store, then reload this page.
        </p>
      )}
    </div>
  );
}
