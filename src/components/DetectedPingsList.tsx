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
import type { ReferenceRecord } from "../types/coinPing";

type Props = {
  pings: DetectedPing[];
  references?: ReferenceRecord[];
  enabled: boolean;
  onClearAll: () => void;
  onDismiss: (id: string) => void;
  onReferenceSaved?: () => void;
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

      {ordered.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Strike a coin. Sustained, tonal spikes above the running noise floor
          will be recorded here.
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
          {ordered.map((ping) => (
            <DetectedPingItem
              key={ping.id}
              ping={ping}
              references={references}
              saved={savedIds.has(ping.id)}
              onDismiss={onDismiss}
              onRequestSave={setPingToSave}
            />
          ))}
        </ul>
      )}

      <SavePingDialog
        ping={pingToSave}
        onClose={() => setPingToSave(null)}
        onSaved={handleSaved}
      />
    </div>
  );
}

type ItemProps = {
  ping: DetectedPing;
  references: readonly ReferenceRecord[];
  saved: boolean;
  onDismiss: (id: string) => void;
  onRequestSave: (ping: DetectedPing) => void;
};

function DetectedPingItem({
  ping,
  references,
  saved,
  onDismiss,
  onRequestSave,
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
            {formatTime(ping.detectedAt)}{" "}
            <span className="font-normal text-muted-foreground">
              · +{(ping.triggerBandDb - ping.baselineBandDb).toFixed(1)} dB above floor
              · sustained {Math.round(ping.topPeakSustainMs)} ms
              {ping.ambientSubtracted ? " · ambient-subtracted" : ""}
            </span>
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

          {hasMatch ? <MatchBanner matches={matches} /> : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onDismiss(ping.id)}
          aria-label="Dismiss ping"
          className="-mr-2 -mt-1"
        >
          ×
        </Button>
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
        {!canSave ? (
          <span className="text-[11px] text-muted-foreground">
            DB unavailable in this environment.
          </span>
        ) : null}
      </div>
    </li>
  );
}

function MatchBanner({ matches }: { matches: ReferenceMatch[] }) {
  const best = matches[0];
  const others = matches.slice(1, 3);

  return (
    <div className="mt-2 rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
      <div className="font-medium">
        <span className="mr-1">✓ Match:</span>
        <span className="text-emerald-100">{best.reference.label}</span>{" "}
        <span className="text-emerald-300/80">
          ({best.matchedRefPeakCount}/{best.reference.peaks.length} peaks ·{" "}
          {Math.round(best.score * 100)}% · ±{Math.round(best.avgErrorHz)} Hz)
        </span>
      </div>
      {others.length > 0 ? (
        <div className="mt-0.5 text-emerald-200/70">
          Also similar:{" "}
          {others
            .map(
              (m) =>
                `${m.reference.label} (${Math.round(m.score * 100)}%)`,
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
};

function SavePingDialog({ ping, onClose, onSaved }: SavePingDialogProps) {
  const [label, setLabel] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ping) {
      setLabel(defaultLabelFor(ping));
      setError(null);
    } else {
      setSaving(false);
      setError(null);
    }
  }, [ping]);

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
      await window.coinPingApi.createReference({
        label: trimmed,
        peaks: ping.peaks.map((p) => ({
          frequencyHz: p.frequencyHz,
          magnitude: p.magnitude,
        })),
      });
      onSaved(ping.id);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }, [ping, saving, label, onSaved, onClose]);

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
