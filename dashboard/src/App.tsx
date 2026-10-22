import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Layout } from "@/components/layout";
import { ToastProvider } from "@/components/common";
import { EndpointPage } from "@/pages/endpoint";
import { EndpointsPage } from "@/pages/endpoints";
import { DeliveriesPage } from "@/pages/deliveries";
import { OverviewPage } from "@/pages/overview";
import { SendPage } from "@/pages/send";
import { api, ApiError, getToken, setToken, tokenRequired } from "@/lib/api";
import { useRoute } from "@/lib/hooks";

export function App() {
  const [authed, setAuthed] = useState(!tokenRequired || Boolean(getToken()));
  const route = useRoute();
  if (!authed) return <TokenGate onDone={() => setAuthed(true)} />;
  const [section = "", id] = route;
  let page;
  if (section === "endpoints" && id) page = <EndpointPage key={id} id={id} />;
  else if (section === "endpoints") page = <EndpointsPage />;
  else if (section === "deliveries") page = <DeliveriesPage />;
  else if (section === "send") page = <SendPage />;
  else page = <OverviewPage />;
  return (
    <ToastProvider>
      <Layout section={section}>{page}</Layout>
    </ToastProvider>
  );
}

function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>reliable-webhooks</CardTitle>
          <CardDescription>This dashboard needs the access token it was started with.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setToken(value);
              try {
                await api.overview();
                onDone();
              } catch (err) {
                setToken(null);
                setError(err instanceof ApiError && err.status === 401 ? "Wrong token" : (err as Error).message);
              }
            }}
          >
            <Input type="password" autoFocus placeholder="Token" value={value} onChange={(e) => setValue(e.target.value)} />
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <Button type="submit">Continue</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
