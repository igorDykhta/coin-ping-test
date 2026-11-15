import { useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Card, CardContent, CardHeader } from "@sqlrooms/ui";

import type { CoinFace, CoinInput, CoinSummary } from "../types/catalog";
import { CoinCatalogForm } from "./CoinCatalogForm";
import { CatalogField, CatalogPhoto, CatalogSelect, coinYear, PhotoPlaceholder } from "./CoinCatalogUi";

export { CoinDetails } from "./CoinDetails";

function CoinCard({ coin, selected, onSelect }: {
  coin: CoinSummary;
  selected: boolean;
  onSelect(): void;
}) {
  const [side, setSide] = useState<CoinFace>("obverse");
  const canFlip = coin.primaryObverseId !== null && coin.primaryReverseId !== null;
  const shownSide = coin.primaryObverseId === null && coin.primaryReverseId !== null ? "reverse" : side;
  const imageId = shownSide === "obverse" ? coin.primaryObverseId : coin.primaryReverseId;
  const identity = [coin.denomination, coinYear(coin), coin.variant].filter(Boolean).join(" · ");

  return (
    <Card className={`gap-0 overflow-hidden py-0 transition-colors hover:border-primary/60 ${selected ? "border-primary/60" : ""}`}>
      <div className="relative aspect-[4/3] overflow-hidden bg-muted/35">
        <button type="button" tabIndex={-1} aria-label={`Open ${coin.name}`} className="size-full" onClick={onSelect}>
          {imageId === null ? (
            <PhotoPlaceholder label="No reference photo" />
          ) : (
            <CatalogPhoto id={imageId} alt={`${coin.name}, ${shownSide}`} className="size-full object-contain p-4" />
          )}
        </button>
        {canFlip && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="absolute right-2 bottom-2"
            onClick={() => setSide(side === "obverse" ? "reverse" : "obverse")}
          >
            {side === "obverse" ? "Show reverse" : "Show obverse"}
          </Button>
        )}
      </div>
      <button
        type="button"
        className="flex flex-1 flex-col gap-3 px-4 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        onClick={onSelect}
      >
        <div>
          <p className="text-base font-semibold">{coin.name}</p>
          {identity && <p className="mt-0.5 text-sm text-muted-foreground">{identity}</p>}
        </div>
        <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
          {coin.composition && <span>{coin.composition}</span>}
          {coin.nominalWeight !== null && <span className="font-mono">{coin.nominalWeight} g</span>}
          {coin.archived && <Badge variant="secondary">Archived</Badge>}
        </div>
        <div className="mt-auto flex flex-wrap gap-1.5 text-xs">
          {coin.imageCount > 0 && <Badge variant="outline">{coin.imageCount} {coin.imageCount === 1 ? "photo" : "photos"}</Badge>}
          {coin.referenceCount > 0 && <Badge variant="outline">{coin.referenceCount} sound {coin.referenceCount === 1 ? "reference" : "references"}</Badge>}
          {coin.sessionCount > 0 && <Badge variant="outline">{coin.sessionCount} {coin.sessionCount === 1 ? "session" : "sessions"}</Badge>}
        </div>
      </button>
    </Card>
  );
}

const pageSize = 24;

export function CoinCatalog({
  coins,
  selectedCoinId,
  onSelect,
  onCreate,
  toolbar,
}: {
  coins: CoinSummary[];
  selectedCoinId?: number | null;
  onSelect(id: number): void;
  onCreate(input: CoinInput): Promise<void>;
  toolbar?: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [country, setCountry] = useState("");
  const [composition, setComposition] = useState("");
  const [year, setYear] = useState("");
  const [availability, setAvailability] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [limit, setLimit] = useState(pageSize);

  const visible = useMemo(
    () => coins.filter((coin) => coin.archived === showArchived),
    [coins, showArchived],
  );
  const countries = distinct(visible.map((coin) => coin.country));
  const compositions = distinct(visible.map((coin) => coin.composition));
  const search = query.trim().toLocaleLowerCase();
  const filtered = visible.filter((coin) => {
    const searchable = [
      coin.name, coin.country, coin.denomination, coin.variant, coin.mint, coin.composition, coinYear(coin),
    ].join(" ").toLocaleLowerCase();
    if (!searchable.includes(search)) return false;
    if (country && coin.country !== country) return false;
    if (composition && coin.composition !== composition) return false;
    if (year && (coin.yearFrom === undefined || Number(year) < coin.yearFrom || Number(year) > (coin.yearTo ?? coin.yearFrom))) return false;
    if (availability === "faces" && (coin.primaryObverseId === null || coin.primaryReverseId === null)) return false;
    if (availability === "sound" && coin.referenceCount === 0) return false;
    if (availability === "sessions" && coin.sessionCount === 0) return false;
    return true;
  });

  function changeFilter(set: (value: string) => void, value: string) {
    set(value);
    setLimit(pageSize);
  }

  function clearFilters() {
    setQuery("");
    setCountry("");
    setComposition("");
    setYear("");
    setAvailability("");
    setLimit(pageSize);
  }

  return (
    <section className="mx-auto w-full max-w-screen-2xl space-y-5 p-4 lg:p-6" aria-labelledby="coin-catalog-title">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="coin-catalog-title" className="text-2xl font-semibold tracking-tight">Coin catalog</h1>
        <div className="flex flex-wrap items-center gap-2">
          {toolbar}
          <Button type="button" onClick={() => setCreating(true)} disabled={creating}>Add coin</Button>
        </div>
      </header>
      {creating && (
        <Card>
          <CardHeader><h2 className="text-lg font-semibold">New coin</h2></CardHeader>
          <CardContent>
            <CoinCatalogForm
              onSave={async (input) => { await onCreate(input); setCreating(false); }}
              onCancel={() => setCreating(false)}
            />
          </CardContent>
        </Card>
      )}
      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-6">
        <div className="sm:col-span-2">
          <CatalogField
            label="Search coins"
            type="search"
            placeholder="Name, mint, variant…"
            value={query}
            onChange={(event) => changeFilter(setQuery, event.target.value)}
          />
        </div>
        <CatalogSelect label="Country" value={country} onChange={(value) => changeFilter(setCountry, value)}>
          <option value="">All countries</option>
          {countries.map((value) => <option key={value}>{value}</option>)}
        </CatalogSelect>
        <CatalogSelect label="Composition" value={composition} onChange={(value) => changeFilter(setComposition, value)}>
          <option value="">All compositions</option>
          {compositions.map((value) => <option key={value}>{value}</option>)}
        </CatalogSelect>
        <CatalogField label="Year" type="number" step={1} value={year} onChange={(event) => changeFilter(setYear, event.target.value)} />
        <CatalogSelect label="Available data" value={availability} onChange={(value) => changeFilter(setAvailability, value)}>
          <option value="">Any</option>
          <option value="faces">Both face photos</option>
          <option value="sound">Sound references</option>
          <option value="sessions">Test sessions</option>
        </CatalogSelect>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {filtered.length} {filtered.length === 1 ? "coin" : "coins"}
        </p>
        <div className="flex gap-2">
          {(query || country || composition || year || availability) && (
            <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showArchived} onChange={(event) => {
              setShowArchived(event.target.checked);
              clearFilters();
            }} />
            Archived coins
          </label>
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          {visible.length ? "No coins match these filters." : showArchived ? "No archived coins." : "Add a coin to start your catalog."}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.slice(0, limit).map((coin) => (
            <CoinCard key={coin.id} coin={coin} selected={coin.id === selectedCoinId} onSelect={() => onSelect(coin.id)} />
          ))}
        </div>
      )}
      {filtered.length > limit && (
        <Button type="button" variant="outline" onClick={() => setLimit((value) => value + pageSize)}>Show more coins</Button>
      )}
    </section>
  );
}

function distinct(values: Array<string | undefined>) {
  const present = values.filter((value): value is string => !!value);
  return [...new Set(present)].sort((a, b) => a.localeCompare(b));
}
