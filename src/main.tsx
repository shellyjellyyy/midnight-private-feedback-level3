// MUST be first: installs the `Buffer` global that
// @midnight-ntwrk/compact-runtime-ledger8 reads as a bare global when
// findDeployedContract() decodes contract state. Any import above this line that
// reaches that runtime could execute it before the polyfill is installed.
// See ./polyfills.ts for the full rationale.
import "./polyfills";

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
