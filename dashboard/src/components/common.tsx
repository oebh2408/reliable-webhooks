import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Attempt, DeliveryStatus, EndpointRow, EndpointState } from "@/lib/api";
import { attemptLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const statusVariant: Record<DeliveryStatus, "success" | "warning" | "danger" | "info"> = {
  delivered: "success",
  pending: "warning",
  sending: "info",
  dead: "danger",
};

export function StatusBadge({ status }: { status: DeliveryStatus }) {
  return <Badge variant={statusVariant[status]}>{status === "dead" ? "dead letter" : status}</Badge>;
}

export function AttemptBadge({ attempt }: { attempt: Attempt | null | undefined }) {
  if (!attempt) return <span className="text-muted-foreground">—</span>;
  const ok = attempt.status >= 200 && attempt.status < 300;
  return (
    <span className={cn("font-mono text-xs", ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
      {attemptLabel(attempt)}
    </span>
  );
}

export type Health = { label: string; variant: "success" | "warning" | "danger" | "secondary"; detail?: string };

export function health(endpoint: { paused?: boolean }, state: EndpointState | null, lastAttempt: Attempt | null, now = Date.now()): Health {
  if (endpoint.paused) return { label: "Paused", variant: "secondary", detail: "Deliveries are held until it is resumed" };
  if (state?.disabled) return { label: "Disabled", variant: "danger", detail: "The endpoint answered 410 Gone" };
  if (state && state.openUntil > now) return { label: "Breaker open", variant: "warning", detail: "Too many consecutive failures" };
  if (lastAttempt && (lastAttempt.status < 200 || lastAttempt.status >= 300)) return { label: "Failing", variant: "warning" };
  return { label: "Healthy", variant: "success" };
}

export function HealthBadge({ row, now }: { row: Pick<EndpointRow, "paused" | "state" | "lastAttempt">; now?: number }) {
  const h = health(row, row.state, row.lastAttempt, now);
  return (
    <Badge variant={h.variant} title={h.detail}>
      <span className="size-1.5 rounded-full bg-current" />
      {h.label}
    </Badge>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      {done ? "Copied" : label}
    </Button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">{children}</div>;
}

export function ErrorNote({ error }: { error?: Error }) {
  if (!error) return null;
  return <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error.message}</div>;
}

type Toast = { id: number; text: string; tone: "ok" | "error" };
const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed right-4 bottom-4 z-[60] flex flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "bg-popover text-popover-foreground animate-in fade-in slide-in-from-bottom-2 rounded-md border px-4 py-3 text-sm shadow-lg",
              t.tone === "error" && "border-red-500/40",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Runs an action, shows its outcome as a toast, and refreshes afterwards. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (action: () => Promise<unknown>, success?: string, after?: () => unknown) => {
      setBusy(true);
      try {
        await action();
        if (success) toast(success);
        await after?.();
        return true;
      } catch (e) {
        toast((e as Error).message, "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}
