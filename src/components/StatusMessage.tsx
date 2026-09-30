import { AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";

export type StatusKind = "info" | "success" | "error" | "pending";

const ICONS: Record<StatusKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertTriangle,
  pending: Loader2,
};

export function StatusMessage({ kind, children }: { kind: StatusKind; children: React.ReactNode }) {
  const Icon = ICONS[kind];
  return (
    <div className={`status status-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon size={16} className={kind === "pending" ? "spin" : undefined} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
