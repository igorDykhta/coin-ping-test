import { useEffect, useMemo, useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@sqlrooms/ui";

import { getReferenceColor } from "../lib/referenceColors";
import type { ReferenceMatch } from "../lib/coinMatcher";
import type { DetectedPing } from "../lib/pingDetector";
import type { CoinSummary } from "../types/catalog";
import type { ReferenceRecord } from "../types/coinPing";
import { DetectedPingsList } from "./DetectedPingsList";
import { LiveSpectrumPanel, type DetectedPingsExternalState, type SoundControls } from "./LiveSpectrumPanel";

const EMPTY_PINGS: DetectedPingsExternalState = {
  pings: [],
  enabled: false,
  clearAll: () => {},
  dismiss: () => {},
};

type Props = {
  coins: CoinSummary[];
  coinId: number | null;
  sessionId?: number;
  soundRequest: number;
  references: ReferenceRecord[];
  onCoinChange: (coinId: number | null) => void;
  onOpenCoin: () => void;
  onChanged: () => void;
  onCreateCoin: (name: string) => Promise<number>;
  onSaveResult: (ping: DetectedPing, matches: ReferenceMatch[]) => Promise<void>;
  onSoundControlsChange: (controls: SoundControls) => void;
};

export function SoundWorkspace({
  coins, coinId, sessionId, soundRequest, references, onCoinChange, onOpenCoin, onChanged, onCreateCoin,
  onSaveResult, onSoundControlsChange,
}: Props) {
  const [pings, setPings] = useState(EMPTY_PINGS);
  const [scope, setScope] = useState<"coin" | "catalog">(coinId ? "coin" : "catalog");
  const [selected, setSelected] = useState<ReadonlySet<number> | null>(null);
  const [linking, setLinking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setScope(coinId === null ? "catalog" : "coin");
    setSelected(null);
    setLinking(null);
  }, [coinId, soundRequest]);

  const coinNames = useMemo(() => new Map(coins.map((coin) => [coin.id, coin.name])), [coins]);
  const activeCoins = useMemo(() => new Set(coins.filter((coin) => !coin.archived).map((coin) => coin.id)), [coins]);
  const allReferences = useMemo(
    () => references.filter((reference) => reference.coinId == null || activeCoins.has(reference.coinId)),
    [activeCoins, references],
  );
  const visibleReferences = useMemo(
    () => scope === "coin" ? allReferences.filter((reference) => reference.coinId === coinId) : allReferences,
    [allReferences, coinId, scope],
  );
  const selectedReferences = useMemo(
    () => visibleReferences.filter((reference) =>
      selected ? selected.has(reference.id) : coinId !== null && reference.coinId === coinId),
    [visibleReferences, selected, coinId],
  );

  function toggleReference(id: number) {
    const next = new Set(selectedReferences.map((reference) => reference.id));
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  }

  async function linkReference(id: number, target: number) {
    setError(null);
    try {
      await window.coinCatalogApi.linkReference(id, target);
      setLinking(null);
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not link the sound reference.");
    }
  }

  function renderReference(reference: ReferenceRecord) {
    const shown = selectedReferences.some((item) => item.id === reference.id);
    return (
      <li key={reference.id} className="rounded-md border border-border">
        <button type="button" aria-pressed={shown} onClick={() => toggleReference(reference.id)}
          className={`flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition-colors ${shown ? "bg-sky-500/15" : "hover:bg-accent/30"}`}>
          <span aria-hidden className="mt-1.5 size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: shown ? getReferenceColor(reference.id) : "transparent" }} />
          <span className="min-w-0">
            <span className="block break-words text-sm font-medium">{reference.label}</span>
            <span className="block text-xs text-muted-foreground">
              {reference.coinId != null ? `${coinNames.get(reference.coinId) ?? "Coin"} · ` : ""}
              {reference.peaks.length} {reference.peaks.length === 1 ? "peak" : "peaks"}
            </span>
          </span>
        </button>
        {reference.coinId == null && activeCoins.size > 0 ? (
          <div className="px-3 pb-2">
            {linking === reference.id ? (
              <select aria-label={`Link ${reference.label} to a coin`} defaultValue=""
                className="w-full rounded-md border border-border bg-background p-1.5 text-xs"
                onChange={(event) => {
                  if (event.target.value) void linkReference(reference.id, Number(event.target.value));
                }}>
                <option value="">Choose a coin…</option>
                {coins.filter((coin) => !coin.archived).map((coin) => (
                  <option key={coin.id} value={coin.id}>{coin.name}</option>
                ))}
              </select>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setLinking(reference.id)}>Link to coin</Button>
            )}
          </div>
        ) : null}
      </li>
    );
  }

  const assigned = visibleReferences.filter((reference) => reference.coinId != null);
  const unassigned = visibleReferences.filter((reference) => reference.coinId == null);

  return (
    <div className="flex min-h-full flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <label className="grid gap-1 text-xs text-muted-foreground">
          Catalog coin
          <select value={coinId ?? ""} onChange={(event) => onCoinChange(event.target.value ? Number(event.target.value) : null)}
            className="min-w-48 rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground">
            <option value="">No coin selected</option>
            {coins.filter((coin) => !coin.archived).map((coin) => <option key={coin.id} value={coin.id}>{coin.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Match against
          <select value={scope} onChange={(event) => setScope(event.target.value === "coin" ? "coin" : "catalog")}
            className="rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground">
            <option value="coin" disabled={coinId === null}>Selected coin</option>
            <option value="catalog">Entire catalog</option>
          </select>
        </label>
        {coinId !== null ? <Button size="sm" variant="outline" onClick={onOpenCoin}>Coin details</Button> : null}
      </div>
      {error ? <p role="alert" className="text-sm text-red-400">{error}</p> : null}
      <div className="grid min-h-[660px] flex-1 grid-cols-[minmax(250px,300px)_minmax(0,1fr)] gap-3 xl:min-h-[700px]">
        <aside className="grid min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1.15fr)] gap-3">
          <Card className="flex min-h-0 flex-col">
            <CardHeader className="pb-2"><CardTitle>Sound references</CardTitle></CardHeader>
            <CardContent className="min-h-0 overflow-y-auto">
              {visibleReferences.length === 0 ? (
                <p className="text-sm text-muted-foreground">Record a ping and save its peaks as a reference.</p>
              ) : null}
              {assigned.length ? <ul className="space-y-2">{assigned.map(renderReference)}</ul> : null}
              {unassigned.length ? (
                <>
                  <h3 className="my-2 text-xs font-medium text-muted-foreground">Unassigned references</h3>
                  <ul className="space-y-2">{unassigned.map(renderReference)}</ul>
                </>
              ) : null}
            </CardContent>
          </Card>
          <Card className="flex min-h-0 flex-col">
            <CardHeader className="pb-2"><CardTitle>Detected pings</CardTitle></CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              <DetectedPingsList
                pings={pings.pings}
                manualRecording={pings.manualRecording}
                references={visibleReferences}
                coins={coins}
                selectedCoinId={coinId}
                enabled={pings.enabled}
                inactiveMessage={pings.inactiveMessage}
                onClearAll={pings.clearAll}
                onDismiss={pings.dismiss}
                onReferenceSaved={onChanged}
                onCreateCoin={onCreateCoin}
                onSaveResult={coinId !== null ? onSaveResult : undefined}
                resultDestination={coinId !== null ? `${coinId}:${sessionId ?? "automatic"}` : undefined}
              />
            </CardContent>
          </Card>
        </aside>
        <LiveSpectrumPanel onDetectedPingsChange={setPings} onSoundControlsChange={onSoundControlsChange}
          selectedReferences={selectedReferences} />
      </div>
    </div>
  );
}
