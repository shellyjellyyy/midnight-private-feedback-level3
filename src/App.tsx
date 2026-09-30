import { useState } from "react";
import { Layout } from "./components/Layout";
import { WalletConnect } from "./components/WalletConnect";
import { SurveyFeedback } from "./components/SurveyFeedback";
import { InviteSecretImport } from "./components/InviteSecretImport";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { useMidnight } from "./hooks/useMidnight";
import { hasStoredInviteSecret } from "./lib/inviteSecret";

export default function App() {
  const { wallet, connect, disconnect, submission, submitFeedback } = useMidnight();  // Only a boolean is tracked here; the secret itself stays inside the import
  // component and the private-state store.
  const [hasInviteSecret, setHasInviteSecret] = useState(() => hasStoredInviteSecret());

  return (
    <Layout>
      <WalletConnect wallet={wallet} onConnect={connect} onDisconnect={disconnect} />
      <InviteSecretImport onChange={setHasInviteSecret} />
      <SurveyFeedback
        wallet={wallet}
        submission={submission}
        onSubmit={submitFeedback}
        hasInviteSecret={hasInviteSecret}
      />
      <DiagnosticsPanel />
    </Layout>
  );
}
