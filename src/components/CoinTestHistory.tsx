import { useState } from "react";
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
  type Specification,
} from "../types/catalog";
import { CatalogError, CatalogField, CatalogNotes, CatalogSelect, formatCatalogDate, useCatalogAction } from "./CoinCatalogUi";
import { formatRange, metricLabels, metrics } from "./CoinSpecifications";

export type CoinComparisonContext = { sessionId: number; comparison?: ImageComparison };

function SessionForm({
  session,
  onSave,
  onCancel,
}: {
  session?: Session;
  onSave(input: SessionInput): Promise<void>;
  onCancel(): void;
}) {
  const [label, setLabel] = useState(session?.label ?? "");
  const [notes, setNotes] = useState(session?.notes ?? "");
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
        <Button size="sm" disabled={busy} type="submit">{session ? "Save session" : "Create session"}</Button>
        <Button size="sm" disabled={busy} type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function MeasurementForm({
  sessionId,
  specifications,
  onChanged,
  onCancel,
}: {
  sessionId: number;
  specifications: Specification[];
  onChanged(): Promise<void>;
  onCancel(): void;
}) {
  const [metric, setMetric] = useState<Metric>("weight");
  const [value, setValue] = useState("");
  const [specificationId, setSpecificationId] = useState("");
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  const { busy, error, run } = useCatalogAction();
  const eligible = specifications.filter((item) => item.metric === metric && formatRange(item));

  function changeMetric(next: string) {
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
          await window.coinCatalogApi.createMeasurement(sessionId, {
            metric,
            value: Number(value),
            specificationId: specificationId ? Number(specificationId) : null,
            method: method.trim() || (metric === "conductivity" ? "GoldScreenSensor" : undefined),
            notes: notes.trim() || undefined,
          });
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
          <CatalogField label={`Reading (${MEASUREMENT_UNITS[metric]})`} required type="number" step="any" min={0} value={value} onChange={(event) => setValue(event.target.value)} />
          <CatalogSelect label="Reference range" value={specificationId} onChange={setSpecificationId}>
            <option value="">No assessment</option>
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
      <CatalogError error={error} />
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy}>Save reading</Button>
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

function Reading({ measurement }: { measurement: Measurement }) {
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
      </div>
      <p className="text-xs text-muted-foreground">
        {[snapshot ? formatRange(snapshot) : undefined, snapshot?.source, measurement.method, formatCatalogDate(measurement.measuredAt)].filter(Boolean).join(" · ")}
      </p>
      {measurement.notes && <p className="whitespace-pre-wrap break-words text-muted-foreground">{measurement.notes}</p>}
    </li>
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
  const [addingReading, setAddingReading] = useState(false);

  return (
    <article className="space-y-3 rounded-lg border border-border bg-background/30 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words font-medium">{session.label}</h3>
          <p className="text-xs text-muted-foreground">{formatCatalogDate(session.createdAt)}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>{editing ? "Close edit" : "Edit"}</Button>
          <Button size="sm" variant="outline" onClick={() => setAddingReading(true)}>Add reading</Button>
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
      {addingReading && (
        <MeasurementForm sessionId={session.id} specifications={specifications} onChanged={onChanged} onCancel={() => setAddingReading(false)} />
      )}
      {session.measurements.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold">Measurements</h4>
          <ul className="divide-y divide-border text-sm">
            {session.measurements.map((measurement) => <Reading key={measurement.id} measurement={measurement} />)}
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
          {session.soundResults.map((result) => (
            <details key={result.id} className="space-y-2 rounded-md border border-border px-3 py-2 text-sm">
              <summary className="cursor-pointer">
                {result.label} <span className="text-xs text-muted-foreground">· {formatCatalogDate(result.createdAt)} · {result.peaks.length} peaks</span>
              </summary>
              <ul className="flex flex-wrap gap-2 font-mono text-xs">
                {result.peaks.map((peak, index) => <li key={index}>{Math.round(peak.frequencyHz)} Hz</li>)}
              </ul>
              {result.matches?.length ? (
                <ul className="flex flex-wrap gap-2 text-xs">
                  {result.matches.map((match) => <li key={match.referenceId}>{match.label} ({Math.round(match.score * 100)}%)</li>)}
                </ul>
              ) : null}
              {result.notes && <p className="whitespace-pre-wrap break-words text-muted-foreground">{result.notes}</p>}
            </details>
          ))}
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
  const [creating, setCreating] = useState(false);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Test history</h2>
        <Button size="sm" variant="outline" disabled={creating} onClick={() => setCreating(true)}>New test session</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {creating && (
          <SessionForm
            onCancel={() => setCreating(false)}
            onSave={async (input) => {
              await window.coinCatalogApi.createSession(coin.id, input);
              await onChanged();
              setCreating(false);
            }}
          />
        )}
        {coin.sessions.length === 0 && !creating && <p className="text-sm text-muted-foreground">Create a test session to log readings, sound results, and photo comparisons.</p>}
        {coin.sessions.map((session) => (
          <SessionEntry key={session.id} session={session} archived={coin.archived} specifications={coin.specifications} onChanged={onChanged} onCompare={onCompare} onSound={onSound} />
        ))}
      </CardContent>
    </Card>
  );
}
