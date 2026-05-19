import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@sqlrooms/ui";

import { DetectedPingsList } from "./components/DetectedPingsList";
import {
  LiveSpectrumPanel,
  type DetectedPingsExternalState,
} from "./components/LiveSpectrumPanel";
import { getReferenceColor } from "./lib/referenceColors";
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
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<
    ReadonlySet<number>
  >(() => new Set());

  const toggleReferenceSelection = useCallback((id: number) => {
    setSelectedReferenceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // All references currently toggled on, in the same order they appear in the
  // sidebar list (so colors / lines stay stable as users add more).
  const selectedReferences = useMemo(
    () => references.filter((r) => selectedReferenceIds.has(r.id)),
    [references, selectedReferenceIds],
  );

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
                  {references.map((reference) => {
                    const selected = selectedReferenceIds.has(reference.id);
                    return (
                      <li key={reference.id}>
                        <button
                          type="button"
                          onClick={() => toggleReferenceSelection(reference.id)}
                          className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                            selected
                              ? "border-sky-400/70 bg-sky-500/15 text-foreground"
                              : "border-border hover:border-border/80 hover:bg-accent/30"
                          }`}
                          title={
                            selected
                              ? "Click again to hide overlay"
                              : "Show this reference's frequencies on the chart"
                          }
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              {selected ? (
                                <span
                                  aria-hidden
                                  className="inline-block h-2.5 w-2.5 flex-none rounded-full ring-1 ring-black/40"
                                  style={{
                                    backgroundColor: getReferenceColor(
                                      reference.id,
                                    ),
                                  }}
                                />
                              ) : null}
                              <div className="truncate font-medium">
                                {reference.label}
                              </div>
                            </div>
                            {selected ? (
                              <span className="rounded-sm bg-sky-500/30 px-1.5 text-[10px] uppercase tracking-wide text-sky-100">
                                shown
                              </span>
                            ) : null}
                          </div>
                          <div className="text-muted-foreground">
                            {reference.peaks.length} peak
                            {reference.peaks.length === 1 ? "" : "s"} ·{" "}
                            {new Date(reference.createdAt).toLocaleString()}
                          </div>
                        </button>
                      </li>
                    );
                  })}
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

        <LiveSpectrumPanel
          onDetectedPingsChange={setPingsState}
          selectedReferences={selectedReferences}
        />
      </div>
      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
    </main>
  );
}
