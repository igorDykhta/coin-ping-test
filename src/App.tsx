import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@sqlrooms/ui";

import { LiveSpectrumPanel } from "./components/LiveSpectrumPanel";
import type { ReferenceRecord } from "./types/coinPing";

export default function App() {
  const [references, setReferences] = useState<ReferenceRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReferences = useCallback(async () => {
    setError(null);
    try {
      const result = await window.coinPingApi.listReferences();
      setReferences(result);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load references.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReferences().catch((unknownError) => {
      setError(unknownError instanceof Error ? unknownError.message : "Unexpected error.");
      setIsLoading(false);
    });
  }, [loadReferences]);

  return (
    <main className="h-screen w-screen p-4">
      <div className="grid h-full grid-cols-[320px_1fr] gap-4">
        <Card className="flex h-full min-h-0 flex-col">
          <CardHeader>
            <CardTitle>Reference recordings</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : references.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No saved references yet. Record a coin ping and mark it as correct to build your
                library.
              </p>
            ) : (
              <ul className="space-y-2">
                {references.map((reference) => (
                  <li
                    key={reference.id}
                    className="rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <div className="font-medium">{reference.label}</div>
                    <div className="text-muted-foreground">
                      {reference.peaks.length} peak{reference.peaks.length === 1 ? "" : "s"} ·{" "}
                      {new Date(reference.createdAt).toLocaleString()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <LiveSpectrumPanel />
      </div>
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
    </main>
  );
}
