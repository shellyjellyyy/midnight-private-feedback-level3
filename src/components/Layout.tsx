import type { ReactNode } from "react";
import { ERA_LABEL } from "../lib/midnight/era.js";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header-inner">
          <span className="brand">Private Feedback</span>
          <span className="brand-subtitle">on Midnight</span>
        </div>
        <div className="page-header-inner">
          <span className="era-badge" title={ERA_LABEL}>
            {ERA_LABEL}
          </span>
        </div>
      </header>
      <main className="page-main">{children}</main>
      <footer className="page-footer">
        <p>
          Built on Midnight. Responses are proven, not trusted — see the{" "}
          <a href="https://github.com" target="_blank" rel="noreferrer">
            source
          </a>{" "}
          for the privacy model.
        </p>
      </footer>
    </div>
  );
}
