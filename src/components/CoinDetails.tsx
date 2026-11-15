import { useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader } from "@sqlrooms/ui";

import type { CoinDetail, CoinFace } from "../types/catalog";
import type { ReferenceRecord } from "../types/coinPing";
import { CoinCatalogForm } from "./CoinCatalogForm";
import { CoinCatalogPhotos } from "./CoinCatalogPhotos";
import { CatalogError, coinYear, formatCatalogDate, useCatalogAction } from "./CoinCatalogUi";
import { CoinSpecifications } from "./CoinSpecifications";
import { CoinTestHistory, type CoinComparisonContext } from "./CoinTestHistory";

export type CoinDetailsProps = {
  coin: CoinDetail;
  onBack(): void;
  onSound(sessionId?: number): void;
  onCompare(side?: CoinFace, context?: CoinComparisonContext): void;
  onChanged(): Promise<void>;
};

function CoinSoundReferences({
  coin,
  onSound,
  onChanged,
}: {
  coin: CoinDetail;
  onSound(): void;
  onChanged(): Promise<void>;
}) {
  const { busy, error, run } = useCatalogAction();

  function unlink(reference: ReferenceRecord) {
    if (!window.confirm(`Move "${reference.label}" to unassigned sound references?`)) return;
    void run(async () => {
      await window.coinCatalogApi.linkReference(reference.id, null);
      await onChanged();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Sound references</h2>
        {!coin.archived && <Button size="sm" variant="outline" onClick={onSound}>Record / compare sound</Button>}
      </CardHeader>
      <CardContent className="space-y-3">
        {coin.references.length === 0 ? (
          <p className="text-sm text-muted-foreground">Save a ping from Sound Analysis to add a resonance reference for this coin.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {coin.references.map((reference) => (
              <li key={reference.id} className="flex flex-wrap items-start justify-between gap-2 p-3">
                <div className="min-w-0 space-y-1">
                  <p className="break-words font-medium">{reference.label}</p>
                  <p className="text-xs text-muted-foreground">{formatCatalogDate(reference.createdAt)} · {reference.peaks.length} peaks</p>
                  <ul className="flex flex-wrap gap-2 font-mono text-xs">
                    {reference.peaks.map((peak, index) => (
                      <li key={index}>{Math.round(peak.frequencyHz)} Hz{peak.kind ? ` (${peak.kind})` : ""}</li>
                    ))}
                  </ul>
                </div>
                <Button size="sm" variant="ghost" onClick={() => unlink(reference)} disabled={busy}>Unassign</Button>
              </li>
            ))}
          </ul>
        )}
        <CatalogError error={error} />
      </CardContent>
    </Card>
  );
}

export function CoinDetails({ coin, onBack, onSound, onCompare, onChanged }: CoinDetailsProps) {
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useCatalogAction();
  const identity = [
    ["Country", coin.country], ["Denomination", coin.denomination],
    ["Year", coinYear(coin)], ["Mint", coin.mint], ["Variant", coin.variant], ["Composition", coin.composition],
  ].filter(([, value]) => value);

  function toggleArchive() {
    void run(async () => {
      const api = window.coinCatalogApi;
      if (coin.archived) await api.restoreCoin(coin.id);
      else await api.archiveCoin(coin.id);
      await onChanged();
    });
  }

  return (
    <section aria-labelledby="coin-details-title" className="mx-auto w-full max-w-screen-2xl space-y-5 p-4 lg:p-6">
      <Button className="-ml-2" type="button" variant="ghost" size="sm" onClick={onBack}>← Coin catalog</Button>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 id="coin-details-title" className="break-words text-2xl font-semibold tracking-tight">{coin.name}</h1>
          {coin.archived && <Badge className="mt-2" variant="secondary">Archived</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          {!coin.archived && (
            <>
              <Button variant="outline" onClick={() => onCompare()}>Compare photos</Button>
              <Button variant="outline" onClick={() => onSound()}>Record / compare sound</Button>
            </>
          )}
          <Button onClick={() => setEditing(true)} disabled={editing}>Edit details</Button>
        </div>
      </header>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Coin details</h2>
          <Button variant="ghost" size="sm" disabled={busy || editing} onClick={toggleArchive}>
            {coin.archived ? "Restore coin" : "Archive coin"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {editing ? (
            <CoinCatalogForm
              coin={coin}
              onCancel={() => setEditing(false)}
              onSave={async (input) => {
                await window.coinCatalogApi.updateCoin(coin.id, input);
                await onChanged();
                setEditing(false);
              }}
            />
          ) : (
            <>
              {identity.length > 0 && (
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {identity.map(([label, value]) => (
                    <div key={label} className="min-w-0 space-y-1">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="break-words text-sm font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {coin.notes && <p className="whitespace-pre-wrap break-words text-sm">{coin.notes}</p>}
              {identity.length === 0 && !coin.notes && <p className="text-sm text-muted-foreground">No identity details added yet.</p>}
            </>
          )}
          <CatalogError error={error} />
        </CardContent>
      </Card>
      <CoinCatalogPhotos coin={coin} onChanged={onChanged} onCompare={(side) => onCompare(side)} />
      <CoinSpecifications coinId={coin.id} specifications={coin.specifications} onChanged={onChanged} />
      <CoinSoundReferences coin={coin} onChanged={onChanged} onSound={() => onSound()} />
      <CoinTestHistory coin={coin} onChanged={onChanged} onCompare={onCompare} onSound={onSound} />
    </section>
  );
}
