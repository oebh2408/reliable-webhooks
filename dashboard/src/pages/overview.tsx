import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AttemptBadge, ErrorNote, HealthBadge, PageHeader, health } from "@/components/common";
import { DeliveriesTable } from "@/components/deliveries";
import { api } from "@/lib/api";
import { duration, relative } from "@/lib/format";
import { navigate, usePolling } from "@/lib/hooks";

export function OverviewPage() {
  const { data, error } = usePolling(api.overview, []);
  const recent = usePolling(() => api.deliveries({ limit: 8 }), []);
  const problems = data?.endpoints.filter((e) => health(e, e.state, e.lastAttempt, data.now).variant !== "success").length ?? 0;
  const tiles = data
    ? [
        { label: "Delivered", value: data.totals.delivered, hint: "Acknowledged with a 2xx" },
        { label: "Waiting", value: data.totals.pending + data.totals.sending, hint: "Queued or between retries" },
        { label: "Dead letters", value: data.totals.dead, hint: "Need attention, can be redelivered" },
        { label: "Endpoints with issues", value: problems, hint: `of ${data.endpoints.length} endpoints` },
      ]
    : [];

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="Deliveries and endpoint health. Refreshes every 2 seconds." />
      <ErrorNote error={error} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="gap-2 py-5">
            <CardHeader className="px-5">
              <CardDescription>{t.label}</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{t.value.toLocaleString()}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground px-5 text-xs">{t.hint}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Endpoints</CardTitle>
          <CardDescription>
            Click one to change its settings or rotate its secret. Success and p95 cover the last 200 attempts by this process; Prometheus
            metrics are at <code>api/metrics</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Endpoint</TableHead>
                <TableHead>Health</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
                <TableHead className="text-right">Dead</TableHead>
                <TableHead className="hidden text-right md:table-cell">Success</TableHead>
                <TableHead className="hidden text-right md:table-cell">p95</TableHead>
                <TableHead>Last response</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.endpoints.map((e) => (
                <TableRow key={e.id} className="cursor-pointer" onClick={() => navigate(`/endpoints/${encodeURIComponent(e.id)}`)}>
                  <TableCell>
                    <div className="font-medium">{e.id}</div>
                    <div className="text-muted-foreground max-w-80 truncate text-xs">{e.url}</div>
                  </TableCell>
                  <TableCell>
                    <HealthBadge row={e} now={data.now} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{e.counts.delivered}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.counts.pending + e.counts.sending}</TableCell>
                  <TableCell className={e.counts.dead ? "text-right font-medium text-red-600 tabular-nums dark:text-red-400" : "text-right tabular-nums"}>
                    {e.counts.dead}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">
                    {e.metrics?.successRate == null ? "—" : `${Math.round(e.metrics.successRate * 100)}%`}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{e.metrics?.p95Ms == null ? "—" : duration(e.metrics.p95Ms)}</TableCell>
                  <TableCell>
                    <AttemptBadge attempt={e.lastAttempt} />
                    {e.lastAttempt && <span className="text-muted-foreground ml-2 text-xs">{relative(e.lastAttempt.at, data.now)}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent deliveries</CardTitle>
          <CardDescription>
            <a className="underline underline-offset-4" href="#/deliveries">
              See all
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent>{recent.data && <DeliveriesTable rows={recent.data} onChange={recent.refresh} />}</CardContent>
      </Card>
    </div>
  );
}
