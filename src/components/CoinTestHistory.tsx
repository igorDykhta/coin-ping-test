import { useState, type ReactNode } from "react";
import { Badge, Button, Card, CardContent, CardHeader } from "@sqlrooms/ui";

import {
  MEASUREMENT_UNITS,
  type CoinDetail,
  type CoinFace,
  type ImageComparison,
  type Measurement,
  type Metric,
  type Session,
  type SessionInput,
  type SoundResult,
  type Specification,
} from "../types/catalog";
import { CatalogError, CatalogField, CatalogNotes, CatalogSelect, formatCatalogDate, useCatalogAction } from "./CoinCatalogUi";
import { formatRange, metricLabels, metrics } from "./CoinSpecifications";
import { SoundResultPlayback } from "./SoundResultPlayback";

export type CoinComparisonContext = { sessionId: number; comparison?: ImageComparison };

function SessionForm({
  session,
  onSave,
  onCancel,
}: {
  session: Session;
  onSave(input: SessionInput): Promise<void>;
  onCancel(): void;
}) {
  const [label, setLabel] = useState(session.label);
  const [notes, setNotes] = useState(session.notes ?? "");
  const { busy, error, run } = useCatalogAction();

  return (
    <form
      className="space-y-3 rounded-md border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          if (!label.trim()) throw new Error("Enter a name for the test session.");
          await onSave({ label: label.trim(), notes: notes.trim() || undefined });
        });
      }}
    >
      <fieldset disabled={busy} className="space-y-3">
        <CatalogField label="Sample or session name" required value={label} onChange={(event) => setLabel(event.target.value)} />
        <CatalogNotes value={notes} onChange={setNotes} />
      </fieldset>
      <CatalogError error={error} />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} type="submit">Save session</Button>
        <Button size="sm" disabled={busy} type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function MeasurementForm({
  sessionId,
  specifications,
  measurement,
  onChanged,
  onCancel,
}: {
  sessionId: number;
  specifications: Specification[];
  measurement?: Measurement;
  onChanged(): Promise<void>;
  onCancel(): void;
}) {
  const [metric, setMetric] = useState<Metric>(measurement?.metric ?? "weight");
  const [value, setValue] = useState(measurement?.value.toString() ?? "");
  const [specificationId, setSpecificationId] = useState(measurement?.specification?.id.toString() ?? "");
  const [method, setMethod] = useState(measurement?.method ?? "");
  const [notes, setNotes] = useState(measurement?.notes ?? "");
  const { busy, error, run } = useCatalogAction();
  const originalRange = measurement?.metric === metric ? measurement.specification : null;
  const eligible = specifications.filter((item) => item.metric === metric && item.id !== originalRange?.id && formatRange(item));
  const chosenSpecification = originalRange?.id.toString() === specificationId
    ? originalRange
    : eligible.find((item) => String(item.id) === specificationId);
  const unavailableRange = specificationId !== "" && !chosenSpecification;

  function changeMetric(next: string) {
    if (next === metric) return;
    setMetric(next as Metric);
    setValue("");
    setSpecificationId("");
    setMethod("");
  }

  return (
    <form
      className="space-y-3 rounded-md border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          if (!value || !Number.isFinite(Number(value))) throw new Error("Enter a reading.");
          if (unavailableRange) throw new Error("Choose another reference range before saving.");
          const input = {
            metric,
            value: Number(value),
            specificationId: chosenSpecification?.id ?? null,
            method: method.trim() || (!measurement && metric === "conductivity" ? "GoldScreenSensor" : undefined),
            notes: notes.trim() || undefined,
          };
          if (measurement) await window.coinCatalogApi.updateMeasurement(sessionId, measurement.id, input);
          else await window.coinCatalogApi.createMeasurement(sessionId, input);
          await onChanged();
          onCancel();
        });
      }}
    >
      <fieldset disabled={busy} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <CatalogSelect label="Metric" value={metric} onChange={changeMetric}>
            {metrics.map((item) => <option key={item} value={item}>{metricLabels[item]}</option>)}
          </CatalogSelect>
          <CatalogField label={`Reading (${MEASUREMENT_UNITS[metric]})`} autoFocus={Boolean(measurement)} required type="number" step="any" min={0} value={value} onChange={(event) => setValue(event.target.value)} />
          <CatalogSelect label="Reference range" value={specificationId} onChange={setSpecificationId}>
            <option value="">No assessment</option>
            {originalRange && (
              <option value={originalRange.id}>
                {formatRange(originalRange) ? `Original range · ${formatRange(originalRange)}` : "Original specification"}
              </option>
            )}
            {unavailableRange && <option value={specificationId} disabled>Previously selected range is unavailable</option>}
            {eligible.map((item) => (
              <option key={item.id} value={item.id}>
                {[formatRange(item), item.source, item.notes].filter(Boolean).join(" · ")}
              </option>
            ))}
          </CatalogSelect>
          <CatalogField
            label="Method or device"
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            placeholder={metric === "conductivity" ? "GoldScreenSensor" : undefined}
          />
        </div>
        <CatalogNotes label="Measurement conditions and notes" value={notes} onChange={setNotes} />
      </fieldset>
      {unavailableRange && <p role="status" className="text-sm text-amber-400">Choose another reference range or select No assessment.</p>}
      <CatalogError error={error} />
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy || unavailableRange}>Save reading</Button>
        <Button size="sm" type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

const statuses = {
  within: "Within range",
  outside: "Outside range",
  "not-assessed": "Not assessed",
} as const;

function Reading({ measurement, disabled, onEdit, children }: {
  measurement: Measurement;
  disabled: boolean;
  onEdit(): void;
  children?: ReactNode;
}) {
  const snapshot = measurement.specification;
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{metricLabels[measurement.metric]}</span>
        <span className="font-mono">{measurement.value} {MEASUREMENT_UNITS[measurement.metric]}</span>
        <Badge
          variant="outline"
          className={measurement.status === "within" ? "text-emerald-400" : measurement.status === "outside" ? "text-amber-400" : "text-muted-foreground"}
        >
          {statuses[measurement.status]}
        </Badge>
        <Button size="sm" type="button" variant="ghost" className="ml-auto" disabled={disabled}
          aria-label={`Edit ${metricLabels[measurement.metric].toLowerCase()} reading (${measurement.value} ${MEASUREMENT_UNITS[measurement.metric]})`}
          onClick={onEdit}>Edit reading</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {[snapshot ? formatRange(snapshot) : undefined, snapshot?.source, measurement.method, formatCatalogDate(measurement.measuredAt)].filter(Boolean).join(" · ")}
      </p>
      {measurement.notes && <p className="whitespace-pre-wrap break-words text-muted-foreground">{measurement.notes}</p>}
      {children}
    </li>
  );
}

function SessionChecklist({ session }: { session: Session }) {
  const entries = metrics.map((metric) => {
    const readings = session.measurements.filter((reading) => reading.metric === metric);
    let state = "Missing";
    if (readings.some((reading) => reading.status === "outside")) state = statuses.outside;
    else if (readings.some((reading) => reading.status === "not-assessed")) state = statuses["not-assessed"];
    else if (readings.length) state = statuses.within;
    return { label: metricLabels[metric], state };
  });
  entries.push(
    { label: "Obverse comparison", state: session.comparisons.some((item) => item.side === "obverse") ? "Saved" : "Missing" },
    { label: "Reverse comparison", state: session.comparisons.some((item) => item.side === "reverse") ? "Saved" : "Missing" },
    { label: "Sound result", state: session.soundResults.length ? "Saved" : "Missing" },
  );
  return (
    <section className="space-y-2" aria-label="Session checklist">
      <h4 className="text-sm font-semibold">Session checklist</h4>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map(({ label, state }) => (
          <li key={label} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
            <span>{label}</span>
            <Badge variant="outline" className={state === statuses.outside ? "text-amber-400" : state === statuses.within || state === "Saved" ? "text-emerald-400" : "text-muted-foreground"}>{state}</Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SoundResultEntry({ result }: { result: SoundResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details className="space-y-2 rounded-md border border-border px-3 py-2 text-sm"
      onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer">
        {result.label} <span className="text-xs text-muted-foreground">
          · {formatCatalogDate(result.createdAt)} · {result.peaks.length} {result.peaks.length === 1 ? "peak" : "peaks"}
          {result.hasAudio ? " · Recording" : ""}
        </span>
      </summary>
      {expanded && result.hasAudio && <SoundResultPlayback resultId={result.id} />}
      {result.peaks.length > 0 && (
        <ul className="flex flex-wrap gap-2 font-mono text-xs">
          {result.peaks.map((peak, index) => (
            <li key={index}>{Math.round(peak.frequencyHz)} Hz{peak.source === "manual" ? " · Manual entry" : ""}</li>
          ))}
        </ul>
      )}
      {result.matches?.length ? (
        <ul className="flex flex-wrap gap-2 text-xs">
          {result.matches.map((match) => <li key={match.referenceId}>{match.label} ({Math.round(match.score * 100)}%)</li>)}
        </ul>
      ) : null}
      {result.notes && <p className="whitespace-pre-wrap break-words text-muted-foreground">{result.notes}</p>}
    </details>
  );
}

function SessionEntry({
  session,
  archived,
  specifications,
  onChanged,
  onCompare,
  onSound,
}: {
  session: Session;
  archived: boolean;
  specifications: Specification[];
  onChanged(): Promise<void>;
  onCompare(side: CoinFace | undefined, context: CoinComparisonContext): void;
  onSound(sessionId: number): void;
}) {
  const [editing, setEditing] = useState(false);
  const [readingForm, setReadingForm] = useState<number | "new" | null>(null);

  return (
    <article className="space-y-3 rounded-lg border border-border bg-background/30 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words font-medium">{session.label}</h3>
          <p className="text-xs text-muted-foreground">{formatCatalogDate(session.createdAt)}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>{editing ? "Close edit" : "Edit"}</Button>
          <Button size="sm" variant="outline" disabled={readingForm !== null} onClick={() => setReadingForm("new")}>Add reading</Button>
          {!archived && (
            <>
              <Button size="sm" variant="outline" onClick={() => onSound(session.id)}>Test sound</Button>
              <Button size="sm" variant="outline" onClick={() => onCompare(undefined, { sessionId: session.id })}>Compare photo</Button>
            </>
          )}
        </div>
      </header>
      {editing ? (
        <SessionForm
          session={session}
          onCancel={() => setEditing(false)}
          onSave={async (input) => {
            await window.coinCatalogApi.updateSession(session.id, input);
            await onChanged();
            setEditing(false);
          }}
        />
      ) : session.notes && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{session.notes}</p>}
      <SessionChecklist session={session} />
      {readingForm === "new" && (
        <MeasurementForm sessionId={session.id} specifications={specifications} onChanged={onChanged} onCancel={() => setReadingForm(null)} />
      )}
      {session.measurements.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold">Measurements</h4>
          <ul className="divide-y divide-border text-sm">
            {session.measurements.map((measurement) => (
              <Reading key={measurement.id} measurement={measurement} disabled={readingForm !== null} onEdit={() => setReadingForm(measurement.id)}>
                {readingForm === measurement.id && (
                  <MeasurementForm sessionId={session.id} specifications={specifications} measurement={measurement}
                    onChanged={onChanged} onCancel={() => setReadingForm(null)} />
                )}
              </Reading>
            ))}
          </ul>
        </div>
      )}
      {session.comparisons.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Image comparisons</h4>
          {session.comparisons.map((comparison) => (
            <div key={comparison.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <div className="min-w-0 space-y-1">
                <p className="capitalize">{comparison.side} comparison</p>
                <p className="text-xs text-muted-foreground">{formatCatalogDate(comparison.updatedAt)}</p>
                {comparison.notes && <p className="whitespace-pre-wrap break-words text-muted-foreground">{comparison.notes}</p>}
              </div>
              <Button size="sm" variant="ghost" onClick={() => onCompare(comparison.side, { sessionId: session.id, comparison })}>Reopen</Button>
            </div>
          ))}
        </div>
      )}
      {session.soundResults.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Sound results</h4>
          {session.soundResults.map((result) => <SoundResultEntry key={result.id} result={result} />)}
        </div>
      )}
    </article>
  );
}

export function CoinTestHistory({
  coin,
  onChanged,
  onCompare,
  onSound,
}: {
  coin: CoinDetail;
  onChanged(): Promise<void>;
  onCompare(side: CoinFace | undefined, context: CoinComparisonContext): void;
  onSound(sessionId: number): void;
}) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">Test history</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        {coin.sessions.length === 0 && <p className="text-sm text-muted-foreground">Start a specimen test to log readings, sound results, and photo comparisons.</p>}
        {coin.sessions.map((session) => (
          <SessionEntry key={session.id} session={session} archived={coin.archived} specifications={coin.specifications} onChanged={onChanged} onCompare={onCompare} onSound={onSound} />
        ))}
      </CardContent>
    </Card>
  );
}
