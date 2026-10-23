import { useEffect, useState } from "react";
import { ArrowLeftIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, PauseIcon, PlayIcon, RotateCcwIcon, SendIcon, Trash2Icon, ZapIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton, ErrorNote, PageHeader, health, useAction } from "@/components/common";
import { DeliveriesTable } from "@/components/deliveries";
import { api, type Endpoint, type EndpointDetail } from "@/lib/api";
import { relative } from "@/lib/format";
import { navigate, usePolling } from "@/lib/hooks";

export function EndpointPage({ id }: { id: string }) {
  const { data: e, error, refresh } = usePolling(() => api.endpoint(id), [id]);
  const deliveries = usePolling(() => api.deliveries({ endpointId: id, limit: 25 }), [id]);
  const overview = usePolling(api.overview, [], 4_000);
  const row = overview.data?.endpoints.find((x) => x.id === id);
  const { run, busy } = useAction();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reload = () => Promise.all([refresh(), deliveries.refresh(), overview.refresh()]);

  if (error && !e) return <ErrorNote error={error} />;
  if (!e) return null;
  const h = health(e, e.state, row?.lastAttempt ?? null);
  const dead = row?.counts.dead ?? 0;
  const breakerOpen = Boolean(e.state && e.state.openUntil > Date.now());

  return (
    <div className="space-y-6">
      <a href="#/endpoints" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
        <ArrowLeftIcon className="size-4" /> Endpoints
      </a>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {e.id}
            <Badge variant={h.variant}>
              <span className="size-1.5 rounded-full bg-current" />
              {h.label}
            </Badge>
          </span>
        }
        description={e.url}
        actions={
          <>
            <Button variant="outline" disabled={busy} onClick={() => run(() => api.sendTest(id), "Test event queued", reload)}>
              <SendIcon />
              Send test event
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => run(() => api.updateEndpoint(id, { paused: !e.paused }), e.paused ? "Resumed" : "Paused", reload)}
            >
              {e.paused ? <PlayIcon /> : <PauseIcon />}
              {e.paused ? "Resume" : "Pause"}
            </Button>
            {dead > 0 && (
              <Button disabled={busy} onClick={() => run(() => api.redeliverEndpoint(id), `${dead} dead letters queued again`, reload)}>
                <RotateCcwIcon />
                Redeliver {dead} dead
              </Button>
            )}
          </>
        }
      />

      {(breakerOpen || e.state?.disabled) && (
        <Card className="border-amber-500/40 bg-amber-500/5 py-4">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span>
              {e.state?.disabled
                ? "This endpoint answered 410 Gone and was disabled. New events are not sent to it."
                : `The circuit breaker is open after repeated failures. Deliveries resume ${relative(e.state!.openUntil)}.`}
            </span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => api.enable(id), "Endpoint enabled", reload)}>
              <ZapIcon />
              {e.state?.disabled ? "Enable" : "Retry now"}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <SettingsCard endpoint={e} onSaved={reload} />
        <SecretsCard endpoint={e} onChange={reload} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Deliveries</CardTitle>
          <CardDescription>
            <a className="underline underline-offset-4" href={`#/deliveries?endpointId=${encodeURIComponent(id)}`}>
              See all for this endpoint
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent>{deliveries.data && <DeliveriesTable rows={deliveries.data} showEndpoint={false} onChange={reload} />}</CardContent>
      </Card>

      <Card className="border-red-500/30">
        <CardHeader>
          <CardTitle>Delete endpoint</CardTitle>
          <CardDescription>Pending deliveries to it become dead letters the next time they come due.</CardDescription>
          <CardAction>
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2Icon />
              Delete
            </Button>
          </CardAction>
        </CardHeader>
      </Card>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {e.id}?</DialogTitle>
            <DialogDescription>This cannot be undone. The receiver keeps working, but nothing more is sent to it.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (await run(() => api.deleteEndpoint(id), "Endpoint deleted")) navigate("/endpoints");
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SettingsCard({ endpoint, onSaved }: { endpoint: Endpoint; onSaved: () => unknown }) {
  const initial = () => ({
    url: endpoint.url,
    description: endpoint.description ?? "",
    eventTypes: endpoint.eventTypes?.join(", ") ?? "",
    rateLimit: endpoint.rateLimit?.toString() ?? "",
    maxConcurrency: endpoint.maxConcurrency?.toString() ?? "",
    timeoutMs: endpoint.timeoutMs?.toString() ?? "",
  });
  const [form, setForm] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const { run, busy } = useAction();
  // Keep the form in sync with the server until the user starts typing.
  useEffect(() => {
    if (!dirty) setForm(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint.url, endpoint.description, endpoint.eventTypes?.join(), endpoint.rateLimit, endpoint.maxConcurrency, endpoint.timeoutMs, dirty]);
  const field = (key: keyof ReturnType<typeof initial>) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setDirty(true);
      setForm({ ...form, [key]: e.target.value });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>Changes apply to deliveries sent from now on.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4"
          onSubmit={async (ev) => {
            ev.preventDefault();
            const ok = await run(
              () =>
                api.updateEndpoint(endpoint.id, {
                  url: form.url,
                  description: form.description,
                  eventTypes: form.eventTypes.split(",").map((s) => s.trim()).filter(Boolean),
                  rateLimit: form.rateLimit === "" ? null : Number(form.rateLimit),
                  maxConcurrency: form.maxConcurrency === "" ? null : Number(form.maxConcurrency),
                  timeoutMs: form.timeoutMs === "" ? null : Number(form.timeoutMs),
                }),
              "Saved",
              onSaved,
            );
            if (ok) setDirty(false);
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="url">URL</Label>
            <Input id="url" type="url" required {...field("url")} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="types">Event types</Label>
            <Input id="types" placeholder="Empty for all event types" {...field("eventTypes")} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Description</Label>
            <Input id="description" {...field("description")} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="rate">Rate (req/s)</Label>
              <Input id="rate" type="number" min={0.01} step="any" placeholder="No limit" {...field("rateLimit")} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="concurrency">Concurrency</Label>
              <Input id="concurrency" type="number" min={1} max={50} step={1} placeholder="1" {...field("maxConcurrency")} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="timeout">Timeout (ms)</Label>
              <Input id="timeout" type="number" min={100} max={120000} step={1} placeholder="Default" {...field("timeoutMs")} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            {dirty && (
              <Button type="button" variant="ghost" onClick={() => setDirty(false)}>
                Discard
              </Button>
            )}
            <Button type="submit" disabled={busy || !dirty}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SecretsCard({ endpoint, onChange }: { endpoint: EndpointDetail; onChange: () => unknown }) {
  const [shown, setShown] = useState<Set<number>>(new Set());
  const { run, busy } = useAction();
  const toggle = (i: number) => setShown((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Signing secrets</CardTitle>
        <CardDescription>
          Every request is signed with each secret. To rotate: add a new one, update the receiver, then remove the old one. For an
          ed25519 key, the receiver gets only the public key.
        </CardDescription>
        <CardAction className="flex flex-col items-end gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => api.rotateSecret(endpoint.id), "New secret added", onChange)}>
            <KeyRoundIcon />
            Add secret
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => run(() => api.rotateSecret(endpoint.id, "ed25519"), "New ed25519 key added", onChange)}
          >
            Add ed25519 key
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {endpoint.secrets.map((secret, i) => {
          const publicKey = endpoint.publicKeys?.[i];
          return (
            <div key={secret} className="flex items-center gap-2 rounded-md border px-3 py-2">
              {publicKey ? (
                <code className="min-w-0 flex-1 truncate font-mono text-xs" title="Public key, for the receiver">
                  {publicKey}
                </code>
              ) : (
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{shown.has(i) ? secret : `${secret.slice(0, 10)}${"•".repeat(24)}`}</code>
              )}
              {publicKey && <Badge variant="outline">ed25519</Badge>}
              {i === 0 && <Badge variant="secondary">newest</Badge>}
              {!publicKey && (
                <Button variant="ghost" size="icon" aria-label={shown.has(i) ? "Hide" : "Show"} onClick={() => toggle(i)}>
                  {shown.has(i) ? <EyeOffIcon /> : <EyeIcon />}
                </Button>
              )}
              <CopyButton value={publicKey ?? secret} />
              {endpoint.secrets.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove"
                  disabled={busy}
                  onClick={() => run(() => api.removeSecret(endpoint.id, i), "Secret removed", () => (setShown(new Set()), onChange()))}
                >
                  <Trash2Icon />
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
