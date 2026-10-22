import type { ReactNode } from "react";
import { ActivityIcon, FlaskConicalIcon, LayoutDashboardIcon, SendIcon, WebhookIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "#/", label: "Overview", icon: LayoutDashboardIcon, match: "" },
  { href: "#/endpoints", label: "Endpoints", icon: WebhookIcon, match: "endpoints" },
  { href: "#/deliveries", label: "Deliveries", icon: ActivityIcon, match: "deliveries" },
  { href: "#/send", label: "Send event", icon: SendIcon, match: "send" },
];

export function Layout({ section, children }: { section: string; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      <aside className="bg-sidebar flex shrink-0 flex-col gap-6 border-b p-4 md:sticky md:top-0 md:h-svh md:w-60 md:border-r md:border-b-0">
        <a href="#/" className="flex items-center gap-2 px-2 font-semibold">
          <span className="bg-primary text-primary-foreground grid size-7 place-items-center rounded-md">
            <WebhookIcon className="size-4" />
          </span>
          reliable-webhooks
        </a>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {NAV.map((n) => (
            <a
              key={n.href}
              href={n.href}
              className={cn(
                "hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1.5 text-sm whitespace-nowrap",
                section === n.match ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground",
              )}
            >
              <n.icon className="size-4" />
              {n.label}
            </a>
          ))}
        </nav>
        <Playground />
      </aside>
      <main className="mx-auto w-full max-w-6xl min-w-0 flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}

/** Shown only when the server runs in playground mode (`npm run dashboard`). */
function Playground() {
  const { data, refresh } = usePolling(() => api.playground().catch(() => null), [], 3_000);
  if (!data) return null;
  const set = async (input: Parameters<typeof api.setPlayground>[0]) => {
    await api.setPlayground(input);
    await refresh();
  };
  const toggles = [
    { key: "traffic", label: "Random traffic", hint: "An event every 1.5 s", value: data.traffic },
    { key: "analyticsDown", label: "Analytics is down", hint: "Its server drops connections", value: data.analyticsDown },
    { key: "legacyFixed", label: "Legacy secret fixed", hint: "Then redeliver its dead letters", value: data.legacyFixed },
  ] as const;
  return (
    <div className="mt-auto hidden space-y-3 rounded-lg border p-3 text-sm md:block">
      <div className="flex items-center gap-2 font-medium">
        <FlaskConicalIcon className="size-4" />
        Playground
      </div>
      <p className="text-muted-foreground text-xs">Local receivers with built-in failures. Nothing leaves this machine.</p>
      {toggles.map((t) => (
        <label key={t.key} className="flex items-center justify-between gap-2">
          <span>
            <span className="block">{t.label}</span>
            <span className="text-muted-foreground block text-xs">{t.hint}</span>
          </span>
          <Switch checked={t.value} onCheckedChange={(v) => set({ [t.key]: v })} />
        </label>
      ))}
      <div className="text-muted-foreground space-y-1 border-t pt-2 text-xs">
        {data.receivers.map((r) => (
          <div key={r.endpointId} className="flex justify-between gap-2" title={r.behaviour}>
            <span>{r.endpointId}</span>
            <span className="tabular-nums">
              {r.processed} ok
              {r.duplicates ? ` · ${r.duplicates} dup` : ""}
              {r.rejected ? ` · ${r.rejected} rej` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
