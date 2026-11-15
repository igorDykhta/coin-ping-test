import { useState } from "react";
import { Button } from "@sqlrooms/ui";

import type { CoinInput } from "../types/catalog";
import { CatalogError, CatalogField, CatalogNotes, useCatalogAction } from "./CoinCatalogUi";

type CoinFormDraft = {
  name: string;
  country: string;
  denomination: string;
  yearFrom: string;
  yearTo: string;
  mint: string;
  variant: string;
  composition: string;
  notes: string;
};

const textFields = [
  { key: "name", label: "Coin name", placeholder: "e.g. American Gold Eagle" },
  { key: "country", label: "Country or issuer", placeholder: "e.g. United States" },
  { key: "denomination", label: "Denomination", placeholder: "e.g. 50 dollars" },
  { key: "mint", label: "Mint" },
  { key: "variant", label: "Variant", placeholder: "e.g. Type 2, 1 oz" },
  { key: "composition", label: "Metal or composition", placeholder: "e.g. Gold, 91.67%" },
] as const;

export function CoinCatalogForm({
  coin,
  onSave,
  onCancel,
}: {
  coin?: CoinInput;
  onSave(input: CoinInput): Promise<void>;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState<CoinFormDraft>({
    name: coin?.name ?? "",
    country: coin?.country ?? "",
    denomination: coin?.denomination ?? "",
    yearFrom: coin?.yearFrom?.toString() ?? "",
    yearTo: coin?.yearTo?.toString() ?? "",
    mint: coin?.mint ?? "",
    variant: coin?.variant ?? "",
    composition: coin?.composition ?? "",
    notes: coin?.notes ?? "",
  });
  const { busy, error, run } = useCatalogAction();

  function update(key: keyof CoinFormDraft, value: string) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  function save() {
    return run(async () => {
      const yearFrom = draft.yearFrom === "" ? undefined : Number(draft.yearFrom);
      const yearTo = draft.yearTo === "" ? undefined : Number(draft.yearTo);
      if (yearTo !== undefined && yearFrom === undefined) {
        throw new Error("Enter a year before adding an end year.");
      }
      if (yearFrom !== undefined && yearTo !== undefined && yearTo < yearFrom) {
        throw new Error("The end year must be the same as or later than the start year.");
      }
      await onSave({
        name: draft.name.trim(),
        country: draft.country.trim() || undefined,
        denomination: draft.denomination.trim() || undefined,
        yearFrom,
        yearTo,
        mint: draft.mint.trim() || undefined,
        variant: draft.variant.trim() || undefined,
        composition: draft.composition.trim() || undefined,
        notes: draft.notes.trim() || undefined,
      });
    });
  }

  return (
    <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-4">
      <fieldset disabled={busy} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {textFields.map(({ key, label, ...props }) => (
            <CatalogField
              key={key}
              label={label}
              required={key === "name"}
              value={draft[key]}
              onChange={(event) => update(key, event.target.value)}
              {...props}
            />
          ))}
          <CatalogField
            label="Year or start year"
            type="number"
            step={1}
            value={draft.yearFrom}
            onChange={(event) => update("yearFrom", event.target.value)}
          />
          <CatalogField
            label="End year (optional)"
            type="number"
            step={1}
            value={draft.yearTo}
            onChange={(event) => update("yearTo", event.target.value)}
          />
        </div>
        <CatalogNotes value={draft.notes} onChange={(value) => update("notes", value)} />
      </fieldset>
      <CatalogError error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : coin ? "Save details" : "Create coin"}</Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}
