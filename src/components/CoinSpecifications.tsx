import { useState } from "react";
import { Button, Card, CardContent, CardHeader } from "@sqlrooms/ui";

import {
  MEASUREMENT_UNITS,
  type Metric,
  type Specification,
  type SpecificationInput,
} from "../types/catalog";
import {
  CatalogError,
  CatalogField,
  CatalogNotes,
  CatalogSelect,
  useCatalogAction,
} from "./CoinCatalogUi";

export const metricLabels = {
  weight: "Weight",
  density: "Density",
  conductivity: "GoldScreenSensor conductivity",
} satisfies Record<Metric, string>;

export const metrics: Metric[] = ["weight", "density", "conductivity"];

export function formatRange(specification: Pick<SpecificationInput, "min" | "max" | "metric">) {
  const unit = MEASUREMENT_UNITS[specification.metric];
  if (specification.min !== undefined && specification.max !== undefined) {
    return `${specification.min}–${specification.max} ${unit}`;
  }
  if (specification.min !== undefined) return `≥ ${specification.min} ${unit}`;
  if (specification.max !== undefined) return `≤ ${specification.max} ${unit}`;
  return "";
}

function SpecificationForm({
  specification,
  onSave,
  onCancel,
}: {
  specification?: Specification;
  onSave(input: SpecificationInput): Promise<void>;
  onCancel(): void;
}) {
  const [metric, setMetric] = useState<Metric>(specification?.metric ?? "weight");
  const [nominal, setNominal] = useState(specification?.nominal?.toString() ?? "");
  const [minimum, setMinimum] = useState(specification?.min?.toString() ?? "");
  const [maximum, setMaximum] = useState(specification?.max?.toString() ?? "");
  const [source, setSource] = useState(specification?.source ?? "");
  const [notes, setNotes] = useState(specification?.notes ?? "");
  const { busy, error, run } = useCatalogAction();
  const unit = MEASUREMENT_UNITS[metric];

  function changeMetric(next: string) {
    if (next === metric) return;
    setMetric(next as Metric);
    setNominal("");
    setMinimum("");
    setMaximum("");
  }

  async function save() {
    await run(async () => {
      const input = {
        metric,
        nominal: nominal === "" ? undefined : Number(nominal),
        min: minimum === "" ? undefined : Number(minimum),
        max: maximum === "" ? undefined : Number(maximum),
        source: source.trim() || undefined,
        notes: notes.trim() || undefined,
      };
      if (input.nominal === undefined && input.min === undefined && input.max === undefined) {
        throw new Error("Enter a nominal value or at least one range bound.");
      }
      if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
        throw new Error("The maximum must be at least the minimum.");
      }
      await onSave(input);
    });
  }

  return (
    <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-3 rounded-md border border-border p-4">
      <fieldset disabled={busy} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <CatalogSelect label="Metric" value={metric} onChange={changeMetric}>
            {metrics.map((item) => <option key={item} value={item}>{metricLabels[item]}</option>)}
          </CatalogSelect>
          <CatalogField label="Source" value={source} onChange={(event) => setSource(event.target.value)} placeholder="Mint, manual, or personal reference" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <CatalogField label={`Nominal value (${unit})`} type="number" step="any" min={0} value={nominal} onChange={(event) => setNominal(event.target.value)} />
          <CatalogField label={`Minimum (${unit})`} type="number" step="any" min={0} value={minimum} onChange={(event) => setMinimum(event.target.value)} />
          <CatalogField label={`Maximum (${unit})`} type="number" step="any" min={0} value={maximum} onChange={(event) => setMaximum(event.target.value)} />
        </div>
        <CatalogNotes label="Applicability notes" value={notes} onChange={setNotes} />
      </fieldset>
      <CatalogError error={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>Save specification</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function CoinSpecifications({
  coinId,
  specifications,
  onChanged,
}: {
  coinId: number;
  specifications: Specification[];
  onChanged(): Promise<void>;
}) {
  const [edit, setEdit] = useState<number | "new" | null>(null);
  const { busy, error, run } = useCatalogAction();
  const editing = specifications.find((item) => item.id === edit);

  function remove(specification: Specification) {
    if (!window.confirm(`Remove this ${metricLabels[specification.metric].toLowerCase()} specification?`)) return;
    void run(async () => {
      await window.coinCatalogApi.deleteSpecification(specification.id);
      await onChanged();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Reference specifications</h2>
        <Button size="sm" variant="outline" disabled={edit !== null || busy} onClick={() => setEdit("new")}>Add specification</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {specifications.length === 0 && edit === null && (
          <p className="text-sm text-muted-foreground">Add nominal values and acceptable ranges for weight, density, or conductivity.</p>
        )}
        {specifications.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {specifications.map((specification) => (
              <li className="flex flex-wrap justify-between gap-2 p-3" key={specification.id}>
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">{metricLabels[specification.metric]}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {specification.nominal !== undefined && (
                      <span>Nominal <span className="font-mono">{specification.nominal} {MEASUREMENT_UNITS[specification.metric]}</span></span>
                    )}
                    {formatRange(specification) && <span>Acceptable <span className="font-mono">{formatRange(specification)}</span></span>}
                  </div>
                  {specification.source && <p className="break-words text-sm text-muted-foreground">{specification.source}</p>}
                  {specification.notes && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{specification.notes}</p>}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" disabled={edit !== null || busy} onClick={() => setEdit(specification.id)}>Edit</Button>
                  <Button size="sm" variant="ghost" disabled={edit !== null || busy} onClick={() => remove(specification)}>Remove</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {edit !== null && (editing || edit === "new") && (
          <SpecificationForm
            key={edit}
            specification={editing}
            onCancel={() => setEdit(null)}
            onSave={async (input) => {
              const api = window.coinCatalogApi;
              if (edit === "new") await api.createSpecification(coinId, input);
              else await api.updateSpecification(edit, input);
              await onChanged();
              setEdit(null);
            }}
          />
        )}
        <CatalogError error={error} />
      </CardContent>
    </Card>
  );
}
