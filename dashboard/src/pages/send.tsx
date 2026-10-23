import { useMemo, useState } from "react";
import { SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, useAction } from "@/components/common";
import { api } from "@/lib/api";
import { navigate, usePolling } from "@/lib/hooks";

const SAMPLE = JSON.stringify({ orderId: "ord_1042", amount: 129.9, currency: "USD" }, null, 2);

export function SendPage() {
  const overview = usePolling(api.overview, [], 10_000);
  const [type, setType] = useState("order.paid");
  const [payload, setPayload] = useState(SAMPLE);
  const [orderingKey, setOrderingKey] = useState("");
  const [only, setOnly] = useState<Set<string>>(new Set());
  const { run, busy } = useAction();

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(payload) as unknown };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [payload]);

  const subscribed = overview.data?.endpoints.filter((e) => !e.eventTypes?.length || e.eventTypes.includes(type)) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Send an event" description="Publishes an event the same way your application would with dispatcher.publish()." />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={async (ev) => {
                ev.preventDefault();
                if (!parsed.ok) return;
                let messageId = "";
                const ok = await run(async () => {
                  const r = await api.publish({
                    type,
                    payload: parsed.value,
                    endpointIds: only.size ? [...only] : undefined,
                    orderingKey: orderingKey.trim() || undefined,
                  });
                  messageId = r.messageId;
                  if (!r.deliveries.length) throw new Error("No endpoint is subscribed to this event type");
                }, "Event published");
                if (ok) navigate(`/deliveries?messageId=${encodeURIComponent(messageId)}`);
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="type">Event type</Label>
                <Input id="type" required value={type} onChange={(e) => setType(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="payload">Payload (JSON)</Label>
                <Textarea
                  id="payload"
                  className="min-h-56 font-mono text-xs"
                  aria-invalid={!parsed.ok}
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                />
                {!parsed.ok && <p className="text-xs text-red-600 dark:text-red-400">{parsed.error}</p>}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ordering">Ordering key</Label>
                <Input id="ordering" placeholder="Optional, for example ord_1042" value={orderingKey} onChange={(e) => setOrderingKey(e.target.value)} />
                <p className="text-muted-foreground text-xs">Events with the same key reach each endpoint in the order they were published.</p>
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={busy || !parsed.ok}>
                  <SendIcon />
                  Publish
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recipients</CardTitle>
            <CardDescription>
              {only.size ? "Only the selected endpoints, whatever their event types." : `Endpoints subscribed to ${type || "this type"}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {overview.data?.endpoints.map((e) => {
              const on = only.size ? only.has(e.id) : subscribed.includes(e);
              return (
                <label key={e.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className={on ? "" : "text-muted-foreground"}>{e.id}</span>
                  <Switch
                    checked={only.has(e.id)}
                    onCheckedChange={(c) => setOnly((s) => (c ? new Set([...s, e.id]) : new Set([...s].filter((x) => x !== e.id))))}
                  />
                </label>
              );
            })}
            <p className="text-muted-foreground text-xs">Turn on switches to send to specific endpoints only.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
