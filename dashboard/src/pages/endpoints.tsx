import { useState } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Empty, ErrorNote, HealthBadge, PageHeader, useAction } from "@/components/common";
import { api } from "@/lib/api";
import { navigate, usePolling } from "@/lib/hooks";

export function EndpointsPage() {
  const { data, error } = usePolling(api.overview, []);
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Endpoints"
        description="Where webhooks are sent. Each one has its own secret, event types and retry state."
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            Add endpoint
          </Button>
        }
      />
      <ErrorNote error={error} />
      {data && !data.endpoints.length && <Empty>No endpoints yet. Add one to start receiving webhooks.</Empty>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.endpoints.map((e) => (
          <Card
            key={e.id}
            role="link"
            tabIndex={0}
            className="hover:border-ring/60 cursor-pointer gap-3 transition-colors"
            onClick={() => navigate(`/endpoints/${encodeURIComponent(e.id)}`)}
            onKeyDown={(ev) => ev.key === "Enter" && navigate(`/endpoints/${encodeURIComponent(e.id)}`)}
          >
            <CardContent className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium">{e.id}</div>
                  <div className="text-muted-foreground truncate text-xs">{e.url}</div>
                </div>
                <HealthBadge row={e} now={data.now} />
              </div>
              {e.description && <p className="text-muted-foreground line-clamp-2 text-sm">{e.description}</p>}
              <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span>{e.eventTypes?.length ? e.eventTypes.join(", ") : "All event types"}</span>
                <span>
                  {e.secrets} secret{e.secrets === 1 ? "" : "s"}
                </span>
                <span className="tabular-nums">
                  {e.counts.delivered} delivered · {e.counts.pending + e.counts.sending} waiting · {e.counts.dead} dead
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <CreateEndpointDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function CreateEndpointDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [form, setForm] = useState({ id: "", url: "", description: "", eventTypes: "" });
  const { run, busy } = useAction();
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    let created = "";
    const ok = await run(async () => {
      const e = await api.createEndpoint({
        id: form.id || undefined,
        url: form.url,
        description: form.description || undefined,
        eventTypes: form.eventTypes.split(",").map((s) => s.trim()).filter(Boolean),
      });
      created = e.id;
    }, "Endpoint created");
    if (ok) {
      onOpenChange(false);
      setForm({ id: "", url: "", description: "", eventTypes: "" });
      navigate(`/endpoints/${encodeURIComponent(created)}`);
    }
  };
  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add endpoint</DialogTitle>
            <DialogDescription>A signing secret is generated for it. You will see it on the next page.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="url">URL</Label>
            <Input id="url" type="url" required placeholder="https://example.com/webhooks" {...field("url")} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="id">Name</Label>
            <Input id="id" placeholder="Taken from the host name if empty" {...field("id")} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="types">Event types</Label>
            <Input id="types" placeholder="order.paid, invoice.issued (empty for all)" {...field("eventTypes")} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">Description</Label>
            <Input id="description" placeholder="Optional" {...field("description")} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
