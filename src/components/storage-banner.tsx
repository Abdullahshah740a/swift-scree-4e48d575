import { CheckCircle2, AlertTriangle, XCircle, Loader2 } from "lucide-react";
import type { StorageStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export function StorageBanner({ status }: { status: StorageStatus | null }) {
  if (!status) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Checking storage status…
      </div>
    );
  }

  let level: "ok" | "warn" | "err";
  let icon: React.ReactNode;
  let label: string;
  let detail: string;

  if (status.configured && status.reachable && status.bucketMatch) {
    level = "ok";
    icon = <CheckCircle2 className="size-4" />;
    label = "Cloud storage connected";
    detail = `Bucket "${status.expectedBucket}" is reachable.`;
  } else if (status.configured && status.reachable && !status.bucketMatch) {
    level = "warn";
    icon = <AlertTriangle className="size-4" />;
    label = "Bucket mismatch";
    detail = `Expected "${status.expectedBucket}" but found: ${
      status.buckets.join(", ") || "none"
    }.`;
  } else {
    level = "err";
    icon = <XCircle className="size-4" />;
    label = "Local-only mode";
    detail = status.error
      ? status.error
      : "Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_BUCKET via the secrets form to sync.";
  }

  const dot = level === "ok" ? "bg-success" : level === "warn" ? "bg-warning" : "bg-destructive";

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        level === "ok"
          ? "border-success/30 bg-success/10"
          : level === "warn"
            ? "border-warning/30 bg-warning/10"
            : "border-destructive/30 bg-destructive/10",
      )}
      role="status"
    >
      <span
        className={cn(
          "mt-0.5 shrink-0",
          level === "ok" ? "text-success" : level === "warn" ? "text-warning" : "text-destructive",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <span className={cn("size-2 rounded-full", dot)} />
          {label}
        </p>
        <p className="mt-0.5 text-muted-foreground">{detail}</p>
        {level !== "ok" && (
          <p className="mt-1 text-xs text-muted-foreground">
            Recordings are saved to this browser for now. Enable Cloud to sync across devices.
          </p>
        )}
      </div>
    </div>
  );
}
