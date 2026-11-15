import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sqlrooms/ui";

import type { CoinDetail, CoinFace, CoinImage, ImageSide } from "../types/catalog";
import { CatalogError, CatalogField, CatalogPhoto, CatalogSelect, PhotoPlaceholder, useCatalogAction } from "./CoinCatalogUi";

const sideLabels = { obverse: "Obverse", reverse: "Reverse", edge: "Edge" };
const sides: ImageSide[] = ["obverse", "reverse", "edge"];

export function CoinCatalogPhotos({
  coin,
  onChanged,
  onCompare,
}: {
  coin: CoinDetail;
  onChanged(): Promise<void>;
  onCompare(side: CoinFace): void;
}) {
  const [importSide, setImportSide] = useState<ImageSide | null>(null);
  const [credit, setCredit] = useState("");
  const [source, setSource] = useState("");
  const [previewId, setPreviewId] = useState<number | null>(null);
  const { busy, error, run } = useCatalogAction();
  const preview = coin.images.find((image) => image.id === previewId);

  function editImport(side: ImageSide) {
    setImportSide(side);
    setCredit("");
    setSource("");
  }

  function importPhoto() {
    if (importSide === null) return;
    void run(async () => {
      const imported = await window.coinCatalogApi.importImage({
        coinId: coin.id,
        side: importSide,
        role: "reference",
        credit: credit.trim() || undefined,
        source: source.trim() || undefined,
      });
      if (imported) {
        await onChanged();
        setImportSide(null);
      }
    });
  }

  function makePrimary(image: CoinImage) {
    void run(async () => {
      await window.coinCatalogApi.setPrimaryImage(image.id);
      await onChanged();
    });
  }

  function deleteImage(image: CoinImage) {
    if (!window.confirm(`Remove this ${sideLabels[image.side].toLowerCase()} photo?`)) return;
    void run(async () => {
      await window.coinCatalogApi.deleteImage(image.id);
      await onChanged();
      setPreviewId(null);
    });
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">Reference photos</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        {importSide !== null && (
          <form
            onSubmit={(event) => { event.preventDefault(); importPhoto(); }}
            className="space-y-3 rounded-md border border-border p-4"
          >
            <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-3">
              <CatalogSelect label="Coin side" value={importSide} onChange={(value) => setImportSide(value as ImageSide)}>
                {sides.map((side) => <option key={side} value={side}>{sideLabels[side]}</option>)}
              </CatalogSelect>
              <CatalogField label="Credit (optional)" value={credit} onChange={(event) => setCredit(event.target.value)} />
              <CatalogField label="Source (optional)" value={source} onChange={(event) => setSource(event.target.value)} />
            </fieldset>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>{busy ? "Importing…" : "Choose photo…"}</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setImportSide(null)}>Cancel</Button>
            </div>
          </form>
        )}
        <CatalogError error={error} />
        <div className="grid gap-4 lg:grid-cols-3">
          {sides.map((side) => {
            const photos = coin.images.filter((image) => image.side === side && image.role === "reference");
            const primary = photos.find((photo) => photo.isPrimary) ?? photos[0];
            return (
              <section key={side} className="min-w-0 space-y-2 rounded-lg border border-border p-3" aria-label={sideLabels[side]}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-medium">{sideLabels[side]} {side === "edge" && <span className="text-xs text-muted-foreground">(optional)</span>}</h3>
                  <Button size="sm" variant="ghost" disabled={busy || importSide !== null} onClick={() => editImport(side)}>Add photo</Button>
                </div>
                <div className="aspect-[4/3] overflow-hidden rounded-md bg-muted/30">
                  {primary ? (
                    <button
                      type="button"
                      className="size-full focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                      onClick={() => setPreviewId(primary.id)}
                    >
                      <CatalogPhoto className="size-full object-contain p-2" id={primary.id} alt={`${coin.name} ${side}`} />
                    </button>
                  ) : <PhotoPlaceholder label={`No ${side} photo`} />}
                </div>
                {(primary?.credit || primary?.source) && (
                  <p className="break-words text-xs text-muted-foreground">{[primary.credit, primary.source].filter(Boolean).join(" · ")}</p>
                )}
                {photos.length > 1 && (
                  <div className="flex flex-wrap gap-2">
                    {photos.map((photo, index) => (
                      <button
                        type="button"
                        key={photo.id}
                        onClick={() => setPreviewId(photo.id)}
                        aria-label={`Open ${sideLabels[side].toLowerCase()} photo ${index + 1}`}
                        className={`size-14 overflow-hidden rounded border ${photo.id === primary?.id ? "border-primary" : "border-border"}`}
                      >
                        <CatalogPhoto className="size-full object-contain" id={photo.id} alt="" />
                      </button>
                    ))}
                  </div>
                )}
                {primary && !coin.archived && side !== "edge" && (
                  <Button size="sm" variant="outline" onClick={() => onCompare(side)}>Compare {side}</Button>
                )}
              </section>
            );
          })}
        </div>
        <Dialog open={preview !== undefined} onOpenChange={(open) => { if (!open) setPreviewId(null); }}>
          {preview && (
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {sideLabels[preview.side]} photo
                  {preview.isPrimary && <Badge variant="outline">Primary</Badge>}
                </DialogTitle>
                <DialogDescription>{coin.name}</DialogDescription>
              </DialogHeader>
              <CatalogPhoto id={preview.id} variant="full" alt={`${coin.name} ${preview.side}`} className="max-h-[60vh] w-full rounded bg-muted/30 object-contain" />
              {(preview.credit || preview.source) && (
                <p className="break-words text-sm text-muted-foreground">{[preview.credit, preview.source].filter(Boolean).join(" · ")}</p>
              )}
              <CatalogError error={error} />
              <div className="flex flex-wrap justify-end gap-2">
                {preview.side !== "edge" && !preview.isPrimary && (
                  <Button variant="outline" disabled={busy} onClick={() => makePrimary(preview)}>Make primary</Button>
                )}
                <Button variant="outline" disabled={busy} onClick={() => deleteImage(preview)}>Remove photo</Button>
                <Button variant="secondary" onClick={() => setPreviewId(null)}>Close</Button>
              </div>
            </DialogContent>
          )}
        </Dialog>
      </CardContent>
    </Card>
  );
}
