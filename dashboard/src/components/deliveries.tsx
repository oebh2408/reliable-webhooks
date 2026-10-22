import { useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AttemptBadge, CopyButton, Empty, StatusBadge, useAction } from "@/components/common";
import { api, type DeliverySummary } from "@/lib/api";
import { attemptLabel, prettyJson, relative, time } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

export function DeliveriesTable({ rows, showEndpoint = true, onChange }: { rows: DeliverySummary[]; showEndpoint?: boolean; onChange?: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <Empty>No deliveries yet.</Empty>;
  const now = Date.now();
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Created</TableHead>
            <TableHead>Event</TableHead>
            {showEndpoint && <TableHead>Endpoint</TableHead>}
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Attempts</TableHead>
            <TableHead>Last response</TableHead>
            <TableHead>Next</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => (
            <TableRow key={d.id} className="cursor-pointer" onClick={() => setOpen(d.id)}>
              <TableCell className="text-muted-foreground" title={time(d.createdAt)}>
                {relative(d.createdAt, now)}
              </TableCell>
              <TableCell>
                <div className="font-medium">{d.eventType}</div>
                <div className="text-muted-foreground font-mono text-xs">{d.messageId}</div>
              </TableCell>
              {showEndpoint && <TableCell>{d.endpointId}</TableCell>}
              <TableCell>
                <StatusBadge status={d.status} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{d.attempts}</TableCell>
              <TableCell>
                <AttemptBadge attempt={d.lastAttempt} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {d.status === "pending" ? relative(d.nextAttemptAt, now) : d.status === "dead" ? d.deadReason : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <DeliverySheet id={open} onClose={() => setOpen(null)} onChange={onChange} />
    </>
  );
}

function DeliverySheet({ id, onClose, onChange }: { id: string | null; onClose: () => void; onChange?: () => void }) {
  const { data: d, refresh } = usePolling(() => (id ? api.delivery(id) : Promise.resolve(undefined)), [id]);
  const { run, busy } = useAction();
  return (
    <Sheet open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader className="border-b">
          <SheetTitle className="font-mono text-sm">{id}</SheetTitle>
          <SheetDescription>{d ? `${d.eventType} to ${d.endpointId}` : "Loading…"}</SheetDescription>
        </SheetHeader>
        {d && (
          <div className="space-y-6 px-4 pb-6">
            <div className="flex items-center justify-between">
              <StatusBadge status={d.status} />
              {d.status === "dead" && (
                <Button size="sm" disabled={busy} onClick={() => run(() => api.redeliver(d.id), "Queued for redelivery", () => (refresh(), onChange?.()))}>
                  <RotateCcwIcon />
                  Redeliver
                </Button>
              )}
            </div>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Message id</dt>
              <dd className="font-mono text-xs">{d.messageId}</dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd>{time(d.createdAt)}</dd>
              <dt className="text-muted-foreground">Attempts</dt>
              <dd>{d.attempts}</dd>
              {d.status === "pending" && (
                <>
                  <dt className="text-muted-foreground">Next attempt</dt>
                  <dd>{time(d.nextAttemptAt)}</dd>
                </>
              )}
              {d.deliveredAt && (
                <>
                  <dt className="text-muted-foreground">Delivered</dt>
                  <dd>{time(d.deliveredAt)}</dd>
                </>
              )}
              {d.deadReason && (
                <>
                  <dt className="text-muted-foreground">Dead reason</dt>
                  <dd>{d.deadReason}</dd>
                </>
              )}
            </dl>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Attempts</h3>
              {d.history.length ? (
                <ol className="space-y-1">
                  {d.history.map((a, i) => (
                    <li key={i} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 rounded-md border px-3 py-2 text-sm">
                      <span className="text-muted-foreground">{time(a.at)}</span>
                      <AttemptBadge attempt={a} />
                      <span className="text-muted-foreground w-16 text-right tabular-nums">{a.durationMs} ms</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-muted-foreground text-sm">Not sent yet.</p>
              )}
              {d.history.length > 0 && d.attempts > d.history.length && (
                <p className="text-muted-foreground text-xs">Showing the last {d.history.length} attempts.</p>
              )}
            </section>
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Body</h3>
                <CopyButton value={d.body} />
              </div>
              <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs leading-relaxed">{prettyJson(d.body)}</pre>
              <p className="text-muted-foreground text-xs">
                Sent with <code>webhook-id: {d.messageId}</code>, a fresh <code>webhook-timestamp</code> and <code>webhook-signature</code> on each
                attempt{d.history.length ? `; last answer ${attemptLabel(d.history.at(-1)!)}` : ""}.
              </p>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
