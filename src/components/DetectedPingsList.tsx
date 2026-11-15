import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sqlrooms/ui";

import { findMatchingReferences, type ReferenceMatch } from "../lib/coinMatcher";
import type { DetectedPing } from "../lib/pingDetector";
import type { CoinSummary } from "../types/catalog";
import type { ReferenceRecord } from "../types/coinPing";

type Props = {
  pings: DetectedPing[];
  references?: ReferenceRecord[];
  enabled: boolean;
  onClearAll: () => void;
  onDismiss: (id: string) => void;
  onReferenceSaved?: () => void;
  manualRecording?: DetectedPing;
  coins?: readonly CoinSummary[];
  selectedCoinId?: number | null;
  onCreateCoin?: (name: string) => Promise<number>;
  onSaveResult?: (ping: DetectedPing, matches: ReferenceMatch[]) => Promise<void>;
  resultDestination?: string;
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function defaultLabelFor(ping: DetectedPing): string {
  const top = ping.peaks[0];
  const time = formatTime(ping.detectedAt);
  if (top) {
    return `Ping ${time} · ${Math.round(top.frequencyHz)} Hz`;
  }
  return `Ping ${time}`;
}

export function DetectedPingsList({
  pings,
  references = [],
  enabled,
  onClearAll,
  onDismiss,
  onReferenceSaved,
  manualRecording,
  coins,
  selectedCoinId,
  onCreateCoin,
  onSaveResult,
  resultDestination,
}: Props) {
  const ordered = useMemo(() => [...pings].reverse(), [pings]);
  const [pingToSave, setPingToSave] = useState<DetectedPing | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());

  const handleSaved = (id: string) => {
    setSavedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    onReferenceSaved?.();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {ordered.length > 0
            ? `${ordered.length} detected`
            : enabled
              ? "Listening for spikes…"
              : "Start listening to begin detection."}
          {enabled ? (
            <span className="ml-2 inline-flex items-center gap-1 text-emerald-400">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              live
            </span>
          ) : null}
        </div>
        {ordered.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClearAll}>
            Clear all
          </Button>
        ) : null}
      </div>

      {ordered.length === 0 && !manualRecording ? (
        <p className="text-xs text-muted-foreground">
          Strike a coin. Sustained, tonal spikes above the running noise floor
          will be recorded here.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
          {manualRecording ? (
            <DetectedPingItem
              key={manualRecording.id}
              ping={manualRecording}
              manual
              references={references}
              saved={savedIds.has(manualRecording.id)}
              onRequestSave={setPingToSave}
              coins={coins}
              onSaveResult={onSaveResult}
              resultDestination={resultDestination}
            />
          ) : null}
          {ordered.map((ping) => (
            <DetectedPingItem
              key={ping.id}
              ping={ping}
              references={references}
              saved={savedIds.has(ping.id)}
              onDismiss={onDismiss}
              onRequestSave={setPingToSave}
              coins={coins}
              onSaveResult={onSaveResult}
              resultDestination={resultDestination}
            />
          ))}
        </ul>
      )}

      <SavePingDialog
        ping={pingToSave}
        onClose={() => setPingToSave(null)}
        onSaved={handleSaved}
        coins={coins}
        selectedCoinId={selectedCoinId}
        onCreateCoin={onCreateCoin}
      />
    </div>
  );
}

type ItemProps = {
  ping: DetectedPing;
  references: readonly ReferenceRecord[];
  saved: boolean;
  onDismiss?: (id: string) => void;
  onRequestSave: (ping: DetectedPing) => void;
  coins?: readonly CoinSummary[];
  manual?: boolean;
  onSaveResult?: Props["onSaveResult"];
  resultDestination?: string;
};

type ResultSaveState = "saving" | "saved" | { error: string };

function DetectedPingItem({
  ping,
  references,
  saved,
  onDismiss,
  onRequestSave,
  coins,
  manual,
  onSaveResult,
  resultDestination = "",
}: ItemProps) {
  const canSave =
    typeof window !== "undefined" && typeof window.coinPingApi !== "undefined";

  const peaksToShow = ping.peaks.slice(0, 4);

  const matches = useMemo(
    () => findMatchingReferences(ping.peaks, references),
    [ping.peaks, references],
  );
  const bestMatch = matches[0];
  const hasMatch = bestMatch !== undefined;
  const [resultStates, setResultStates] = useState(() => new Map<string, ResultSaveState>());
  const resultState = resultStates.get(resultDestination);
  const resultError = typeof resultState === "object" ? resultState.error : null;

  async function saveResult() {
    if (!onSaveResult || resultState === "saving" || resultState === "saved") return;
    const setResult = (nextState: ResultSaveState) => {
      setResultStates((previous) => new Map(previous).set(resultDestination, nextState));
    };
    setResult("saving");
    try {
      await onSaveResult(ping, matches);
      setResult("saved");
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : "Could not save the test result." });
    }
  }

  return (
    <li
      className={`rounded-md border px-3 py-2 text-xs ${
        hasMatch
          ? "border-emerald-500/50 bg-emerald-500/10"
          : "border-border bg-background/60"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">
            {manual ? "Manual recording" : formatTime(ping.detectedAt)}{" "}
            {!manual ? <span className="font-normal text-muted-foreground">
              · +{(ping.triggerBandDb - ping.baselineBandDb).toFixed(1)} dB above floor
              · sustained {Math.round(ping.topPeakSustainMs)} ms
              {ping.ambientSubtracted ? " · ambient-subtracted" : ""}
            </span> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
            {peaksToShow.map((p, idx) => (
              <span key={idx} className="font-mono">
                {Math.round(p.frequencyHz)} Hz · {p.magnitude.toFixed(1)} dB
                {p.kind === "short" ? (
                  <span className="ml-1 rounded-sm bg-amber-500/20 px-1 text-[10px] text-amber-300">
                    short
                  </span>
                ) : p.kind === "long" ? (
                  <span className="ml-1 rounded-sm bg-emerald-500/20 px-1 text-[10px] text-emerald-300">
                    long
                  </span>
                ) : null}
              </span>
            ))}
          </div>

          {hasMatch ? <MatchBanner matches={matches} coins={coins} /> : null}
        </div>
        {onDismiss ? <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onDismiss(ping.id)}
          aria-label="Dismiss ping"
          className="-mr-2 -mt-1"
        >
          ×
        </Button> : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={saved ? "outline" : "default"}
          onClick={() => onRequestSave(ping)}
          disabled={!canSave}
        >
          {saved ? "Saved · Save again…" : "Save as reference…"}
        </Button>
        {onSaveResult ? (
          <Button type="button" size="sm" variant="ghost"
            onClick={() => void saveResult()} disabled={resultState === "saving" || resultState === "saved"}>
            {resultState === "saved" ? "Test result saved" : resultState === "saving" ? "Saving…" : "Save test result"}
          </Button>
        ) : null}
        {!canSave ? (
          <span className="text-[11px] text-muted-foreground">
            DB unavailable in this environment.
          </span>
        ) : null}
      </div>
      {resultError ? <p role="alert" className="mt-1 text-xs text-red-400">{resultError}</p> : null}
    </li>
  );
}

function MatchBanner({ matches, coins }: { matches: ReferenceMatch[]; coins?: readonly CoinSummary[] }) {
  const best = matches[0];
  const others = matches.slice(1, 3);
  function matchLabel(reference: ReferenceRecord) {
    const coin = coins?.find((entry) => entry.id === reference.coinId);
    return coin ? `${coin.name} · ${reference.label}` : reference.label;
  }

  return (
    <div className="mt-2 rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
      <div className="font-medium">
        <span className="mr-1">✓ Match:</span>
        <span className="text-emerald-100">{matchLabel(best.reference)}</span>{" "}
        <span className="text-emerald-300/80">
          ({best.matchedRefPeakCount}/{best.comparedRefPeakCount} peaks ·{" "}
          {Math.round(best.score * 100)}% · ±{Math.round(best.avgErrorHz)} Hz)
        </span>
      </div>
      {others.length > 0 ? (
        <div className="mt-0.5 text-emerald-200/70">
          Also similar:{" "}
          {others
            .map(
              (m) =>
                `${matchLabel(m.reference)} (${Math.round(m.score * 100)}%)`,
            )
            .join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

type SavePingDialogProps = {
  ping: DetectedPing | null;
  onClose: () => void;
  onSaved: (id: string) => void;
  coins?: readonly CoinSummary[];
  selectedCoinId?: number | null;
  onCreateCoin?: (name: string) => Promise<number>;
};

function SavePingDialog({ ping, onClose, onSaved, coins, selectedCoinId, onCreateCoin }: SavePingDialogProps) {
  const [label, setLabel] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [coinSelection, setCoinSelection] = useState("");
  const [coinName, setCoinName] = useState("");
  const [createdCoin, setCreatedCoin] = useState<{ id: number; name: string } | null>(null);
  const activeCoins = coins?.filter((coin) => !coin.archived);
  const defaultCoinSelection = activeCoins?.some((coin) => coin.id === selectedCoinId)
    ? String(selectedCoinId) : "";
  const pendingCoin = createdCoin && !coins?.some((coin) => coin.id === createdCoin.id) ? createdCoin : null;
  const selectableCoins = pendingCoin ? [...(activeCoins ?? []), pendingCoin] : activeCoins;
  const visibleCoinSelection = (
    (coinSelection === "new" && onCreateCoin) ||
    selectableCoins?.some((coin) => String(coin.id) === coinSelection)
  ) ? coinSelection : "";

  useEffect(() => {
    if (createdCoin && !pendingCoin) setCreatedCoin(null);
  }, [createdCoin, pendingCoin]);

  useEffect(() => {
    if (ping) {
      setLabel(defaultLabelFor(ping));
      setCoinSelection(defaultCoinSelection);
      setCoinName("");
      setCreatedCoin(null);
      setError(null);
    } else {
      setSaving(false);
      setError(null);
    }
  }, [ping, defaultCoinSelection]);

  const handleConfirm = useCallback(async () => {
    if (!ping || saving) return;
    const trimmed = label.trim();
    if (!trimmed) {
      setError("Please enter a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let coinId = visibleCoinSelection ? Number(visibleCoinSelection) : null;
      if (visibleCoinSelection === "new") {
        const name = coinName.trim();
        if (!onCreateCoin || !name) throw new Error("Enter a name for the new coin.");
        coinId = await onCreateCoin(name);
        setCreatedCoin({ id: coinId, name });
        setCoinSelection(String(coinId));
      }
      await window.coinPingApi.createReference({
        label: trimmed,
        ...(coins ? { coinId } : {}),
        peaks: ping.peaks.map((p) => ({
          frequencyHz: p.frequencyHz,
          magnitude: p.magnitude,
          kind: p.kind,
          sustainMs: p.sustainMs,
          accumulatedPowerDb: p.accumulatedPowerDb,
        })),
      });
      onSaved(ping.id);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }, [ping, saving, label, visibleCoinSelection, coinName, coins, onCreateCoin, onSaved, onClose]);

  const open = ping !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save coin ping as reference</DialogTitle>
          <DialogDescription>
            {ping ? (
              <>
                Detected at {formatTime(ping.detectedAt)} · sustained{" "}
                {Math.round(ping.topPeakSustainMs)} ms ·{" "}
                {ping.ambientSubtracted ? "ambient-subtracted" : "raw"}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {ping ? (
          <div className="space-y-3">
            {coins ? (
              <div className="space-y-1">
                <label htmlFor="save-ping-coin" className="block text-xs font-medium">Catalog coin</label>
                <select id="save-ping-coin" value={visibleCoinSelection} onChange={(event) => setCoinSelection(event.target.value)}
                  disabled={saving} className="w-full rounded-md border border-border bg-background p-2 text-sm">
                  <option value="">Unassigned</option>
                  {selectableCoins?.map((coin) => <option key={coin.id} value={coin.id}>{coin.name}</option>)}
                  {onCreateCoin ? <option value="new">Create a coin…</option> : null}
                </select>
                {visibleCoinSelection === "new" ? <input aria-label="New coin name" placeholder="New coin name"
                  value={coinName} onChange={(event) => setCoinName(event.target.value)} disabled={saving}
                  className="w-full rounded-md border border-border bg-background p-2 text-sm" /> : null}
              </div>
            ) : null}
            <div>
              <label
                htmlFor="save-ping-label"
                className="mb-1 block text-xs font-medium text-foreground"
              >
                Name
              </label>
              <input
                id="save-ping-label"
                type="text"
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleConfirm();
                  }
                }}
                placeholder="e.g. 1989 Quarter (USA)"
                autoFocus
                disabled={saving}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div>
              <div className="mb-1 text-xs font-medium text-foreground">
                Peaks ({ping.peaks.length})
              </div>
              <ul className="space-y-0.5 rounded-md border border-border bg-background/60 p-2 text-xs text-muted-foreground">
                {ping.peaks.map((p, idx) => (
                  <li key={idx} className="font-mono">
                    {Math.round(p.frequencyHz)} Hz ({p.magnitude.toFixed(1)} dB)
                    {p.kind === "short" ? (
                      <span className="ml-2 rounded-sm bg-amber-500/20 px-1 text-[10px] text-amber-300">
                        short
                      </span>
                    ) : p.kind === "long" ? (
                      <span className="ml-2 rounded-sm bg-emerald-500/20 px-1 text-[10px] text-emerald-300">
                        long
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>

            {error ? <p className="text-xs text-red-500">{error}</p> : null}
          </div>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={saving}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={saving || !ping || !label.trim()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
