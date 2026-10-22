import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

/** Loads data and reloads it every `intervalMs` while the tab is visible. */
export function usePolling<T>(load: () => Promise<T>, deps: unknown[], intervalMs = 2_000) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<ApiError | Error | undefined>();
  const loader = useRef(load);
  loader.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loader.current());
      setError(undefined);
    } catch (e) {
      setError(e as Error);
    }
  }, []);

  useEffect(() => {
    setData(undefined);
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, refresh };
}

/** The current location hash, split into path segments: "#/endpoints/crm" -> ["endpoints", "crm"]. */
export function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function useQueryParams(): URLSearchParams {
  const read = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const [params, setParams] = useState(read);
  useEffect(() => {
    const on = () => setParams(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return params;
}

export function navigate(path: string): void {
  window.location.hash = path;
}
