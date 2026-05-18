import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@sqlrooms/ui";

import { DetectedPingsList } from "./components/DetectedPingsList";
import {
  LiveSpectrumPanel,
  type DetectedPingsExternalState,
} from "./components/LiveSpectrumPanel";
import type { ReferenceRecord } from "./types/coinPing";

const EMPTY_PINGS_STATE: DetectedPingsExternalState = {
  pings: [],
  enabled: false,
  clearAll: () => {},
  dismiss: () => {},
};

export default function App() {
  const [references, setReferences] = useState<ReferenceRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pingsState, setPingsState] =
    useState<DetectedPingsExternalState>(EMPTY_PINGS_STATE);

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
        <div className="flex h-full min-h-0 flex-col gap-4">
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="pb-2">
              <CardTitle>Reference recordings</CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-y-auto">
              {isLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : references.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No saved references yet. Detect a coin ping and save it to
                  build your library.
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
                        {reference.peaks.length} peak
                        {reference.peaks.length === 1 ? "" : "s"} ·{" "}
                        {new Date(reference.createdAt).toLocaleString()}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="pb-2">
              <CardTitle>Detected pings</CardTitle>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              <DetectedPingsList
                pings={pingsState.pings}
                references={references}
                enabled={pingsState.enabled}
                onClearAll={pingsState.clearAll}
                onDismiss={pingsState.dismiss}
                onReferenceSaved={() => void loadReferences()}
              />
            </CardContent>
          </Card>
        </div>

        <LiveSpectrumPanel onDetectedPingsChange={setPingsState} />
      </div>
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
    </main>
  );
}
