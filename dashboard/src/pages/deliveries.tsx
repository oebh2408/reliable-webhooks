import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorNote, PageHeader } from "@/components/common";
import { DeliveriesTable } from "@/components/deliveries";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { navigate, usePolling, useQueryParams } from "@/lib/hooks";

const ALL = "all";

export function DeliveriesPage() {
  const params = useQueryParams();
  const status = params.get("status") ?? ALL;
  const endpointId = params.get("endpointId") ?? ALL;
  const messageId = params.get("messageId") ?? "";
  const endpoints = usePolling(api.overview, [], 10_000);
  const { data, error, refresh } = usePolling(
    () => api.deliveries({ status: status === ALL ? undefined : status, endpointId: endpointId === ALL ? undefined : endpointId, messageId, limit: 200 }),
    [status, endpointId, messageId],
  );

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === ALL || !value) next.delete(key);
    else next.set(key, value);
    navigate(`/deliveries?${next}`);
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Deliveries" description="One row per message and endpoint, newest first. Click a row for its attempts and body." />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(v) => set("status", v)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="sending">Sending</SelectItem>
            <SelectItem value="delivered">Delivered</SelectItem>
            <SelectItem value="dead">Dead letters</SelectItem>
          </SelectContent>
        </Select>
        <Select value={endpointId} onValueChange={(v) => set("endpointId", v)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All endpoints</SelectItem>
            {endpoints.data?.endpoints.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {messageId && (
          <Button variant="outline" size="sm" onClick={() => set("messageId", "")}>
            Message {messageId} ✕
          </Button>
        )}
      </div>
      <ErrorNote error={error} />
      <Card className="py-2">
        <CardContent className="px-2">{data && <DeliveriesTable rows={data} onChange={refresh} />}</CardContent>
      </Card>
    </div>
  );
}
