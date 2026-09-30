import { Layout } from "./components/Layout";
import { WalletConnect } from "./components/WalletConnect";
import { SurveyFeedback } from "./components/SurveyFeedback";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { useMidnight } from "./hooks/useMidnight";

export default function App() {
  const { wallet, connect, disconnect, submission, submitFeedback } = useMidnight();

  return (
    <Layout>
      <WalletConnect wallet={wallet} onConnect={connect} onDisconnect={disconnect} />
      <SurveyFeedback wallet={wallet} submission={submission} onSubmit={submitFeedback} />
      <DiagnosticsPanel />
    </Layout>
  );
}
