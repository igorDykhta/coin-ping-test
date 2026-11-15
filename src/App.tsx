import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@sqlrooms/ui";

import { CoinCatalog, CoinDetails } from "./components/CoinCatalog";
import { ImageComparison, type ComparisonPhoto, type ImageComparisonDraft } from "./components/ImageComparison";
import type { SoundControls } from "./components/LiveSpectrumPanel";
import { SoundWorkspace } from "./components/SoundWorkspace";
import { imageUrl } from "./lib/catalogMedia";
import type { ReferenceMatch } from "./lib/coinMatcher";
import type { DetectedPing } from "./lib/pingDetector";
import type { CoinDetail, CoinFace, CoinImage, CoinInput, CoinSummary, ImageComparison as SavedComparison } from "./types/catalog";
import type { ReferenceRecord } from "./types/coinPing";

type Page = "catalog" | "details" | "sound" | "images";
type PhotoContext = { sessionId: number; comparison?: SavedComparison };
type PhotoRequest = { side: CoinFace; requestId: number };
const TABS = [
  ["catalog", "Catalog"],
  ["sound", "Sound analysis"],
  ["images", "Image comparison"],
] as const;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : String(error);
}

function toComparisonPhoto(image: CoinImage): ComparisonPhoto | null {
  if (image.side === "edge") return null;
  return {
    id: image.id,
    side: image.side,
    name: image.isPrimary ? "Primary reference" : `${image.side === "obverse" ? "Obverse" : "Reverse"} photo #${image.id}`,
    url: imageUrl(image.id),
    primary: image.isPrimary,
  };
}

function CoinPhotoWorkspace({ coin, comparison, requestedSide, onOpenCoin, onImport, onSave }: {
  coin: CoinDetail | null;
  comparison?: SavedComparison;
  requestedSide?: PhotoRequest;
  onOpenCoin: () => void;
  onImport: (side: CoinFace) => Promise<ComparisonPhoto | null>;
  onSave: (draft: ImageComparisonDraft, comparisonId?: number) => Promise<number>;
}) {
  const photos = coin?.images ?? [];
  const saved = useRef<Partial<Record<CoinFace, number>>>(
    comparison ? { [comparison.side]: comparison.id } : {},
  );
  let initial: ImageComparisonDraft | undefined;
  if (comparison) {
    const image = photos.find((photo) => photo.id === comparison.candidateImageId);
    const candidate = image && toComparisonPhoto(image);
    if (candidate) initial = {
      side: comparison.side,
      candidate,
      referenceImageId: comparison.referenceImageId,
      alignment: comparison.alignment,
      notes: comparison.notes ?? "",
    };
  }
  const getPhotos = (role: CoinImage["role"]) => photos.flatMap((image) => {
    const photo = image.role === role ? toComparisonPhoto(image) : null;
    return photo ? [photo] : [];
  });

  return <ImageComparison
    coinName={coin?.name ?? null}
    requestedSide={requestedSide}
    referenceImages={getPhotos("reference")}
    candidateImages={getPhotos("candidate")}
    initial={initial}
    importCandidate={onImport}
    onOpenCoin={coin ? onOpenCoin : undefined}
    onSave={async (draft) => {
      saved.current[draft.side] = await onSave(draft, saved.current[draft.side]);
    }}
  />;
}

export default function App() {
  const [page, setPage] = useState<Page>("catalog");
  const [coinId, setCoinId] = useState<number | null>(null);
  const selectedCoinRef = useRef<number | null>(null);
  const [coins, setCoins] = useState<CoinSummary[]>([]);
  const [references, setReferences] = useState<ReferenceRecord[]>([]);
  const [coinDetail, setCoinDetail] = useState<CoinDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [backupBusy, setBackupBusy] = useState(false);
  const [photoContext, setPhotoContext] = useState<PhotoContext>();
  const [requestedSide, setRequestedSide] = useState<PhotoRequest>();
  const [soundSession, setSoundSession] = useState<number>();
  const [soundRequest, setSoundRequest] = useState(0);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const soundControls = useRef<SoundControls | null>(null);
  const sessions = useRef(new Map<number, Promise<number>>());
  const detailRequest = useRef(0);
  const libraryRequest = useRef(0);
  const coin = coinDetail?.id === coinId ? coinDetail : null;

  const refresh = useCallback(async (id = selectedCoinRef.current) => {
    const librarySequence = ++libraryRequest.current;
    const detailSequence = ++detailRequest.current;
    const [nextCoins, nextReferences, nextCoin] = await Promise.all([
      window.coinCatalogApi.listCoins(),
      window.coinPingApi.listReferences(),
      id === null ? Promise.resolve(null) : window.coinCatalogApi.getCoin(id),
    ]);
    if (librarySequence === libraryRequest.current) {
      setCoins(nextCoins);
      setReferences(nextReferences);
    }
    if (detailSequence === detailRequest.current && id === selectedCoinRef.current) setCoinDetail(nextCoin);
  }, []);

  const refreshAfterWrite = useCallback(() => {
    void refresh().catch((failure: unknown) => setError(errorMessage(failure)));
  }, [refresh]);

  useEffect(() => {
    let active = true;
    if (!window.coinCatalogApi || !window.coinPingApi) {
      setLoading(false);
      setError("Open the Electron app to use the catalog and saved references.");
      return;
    }
    void refresh()
      .catch((failure: unknown) => { if (active) setError(errorMessage(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  function selectCoin(id: number | null) {
    if (selectedCoinRef.current === id) return;
    selectedCoinRef.current = id;
    setCoinId(id);
    setCoinDetail(null);
    setSoundSession(undefined);
    setPhotoContext(undefined);
    setRequestedSide(undefined);
    if (id === null) {
      detailRequest.current += 1;
      return;
    }
    const sequence = ++detailRequest.current;
    void window.coinCatalogApi.getCoin(id).then((detail) => {
      if (sequence === detailRequest.current) setCoinDetail(detail);
    }).catch((failure: unknown) => {
      if (sequence === detailRequest.current) setError(errorMessage(failure));
    });
  }

  const registerSoundControls = useCallback((controls: SoundControls) => {
    soundControls.current = controls;
  }, []);

  async function finishNavigation(action: () => void, finishRecording: boolean) {
    setNavigationBusy(true);
    try {
      if (finishRecording) await soundControls.current?.finishRecording();
      await soundControls.current?.stopListening();
      setPendingNavigation(null);
      action();
    } catch (failure) {
      setError(errorMessage(failure));
      setPendingNavigation(null);
    } finally {
      setNavigationBusy(false);
    }
  }

  function navigate(next: Page, action?: () => void) {
    if (navigationBusy) return;
    const open = () => {
      setError(null);
      setNotice(null);
      action?.();
      setPage(next);
    };
    if (page !== "sound" || next === "sound") {
      open();
    } else if (soundControls.current?.isRecording) {
      setPendingNavigation(() => open);
    } else {
      void finishNavigation(open, false);
    }
  }

  function openDetails() {
    if (coinId !== null) navigate("details");
  }

  async function createCoin(input: CoinInput) {
    const created = await window.coinCatalogApi.createCoin(input);
    selectCoin(created.id);
    setCoinDetail(created);
    setPage("details");
    refreshAfterWrite();
  }

  function openSound(sessionId?: number) {
    navigate("sound", () => {
      setSoundSession(sessionId);
      setSoundRequest((prior) => prior + 1);
    });
  }

  function openImages(side?: CoinFace, context?: PhotoContext) {
    navigate("images", () => {
      setPhotoContext(context);
      if (side) setRequestedSide((prior) => ({ side, requestId: (prior?.requestId ?? 0) + 1 }));
    });
  }

  function getSession(id: number, explicitSession?: number): Promise<number> {
    if (explicitSession !== undefined) return Promise.resolve(explicitSession);
    const existing = sessions.current.get(id);
    if (existing) return existing;
    const pending = window.coinCatalogApi.createSession(id, {
      label: `Test · ${new Date().toLocaleString()}`,
    }).then((session) => session.id).catch((failure: unknown) => {
      sessions.current.delete(id);
      throw failure;
    });
    sessions.current.set(id, pending);
    return pending;
  }

  async function saveSoundResult(ping: DetectedPing, matches: ReferenceMatch[]) {
    if (coinId === null) throw new Error("Select a catalog coin before saving a sound result.");
    const sessionId = await getSession(coinId, soundSession);
    await window.coinCatalogApi.saveSoundResult(sessionId, {
      label: `Sound · ${new Date(ping.detectedAt).toLocaleString()}`,
      peaks: ping.peaks,
      matches: matches.map(({ reference, score }) => {
        const matchedCoin = coins.find((row) => row.id === reference.coinId);
        return { referenceId: reference.id, label: matchedCoin ? `${matchedCoin.name} · ${reference.label}` : reference.label, score };
      }),
    });
    refreshAfterWrite();
  }

  async function runBackup(restore: boolean) {
    setBackupBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (restore) {
        if (await window.coinCatalogApi.importBackup()) window.location.reload();
      } else if (await window.coinCatalogApi.exportBackup()) {
        setNotice("Coin library backup saved in the selected folder.");
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBackupBusy(false);
    }
  }

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b border-border bg-card px-5 py-3">
        <span className="whitespace-nowrap text-sm font-semibold tracking-wide">Coin Ping Analyzer</span>
        <nav aria-label="Workspaces" className="flex gap-1">
          {TABS.map(([target, label]) => {
            const active = page === target || (target === "catalog" && page === "details");
            return <Button key={target} size="sm" variant={active ? "secondary" : "ghost"}
              aria-current={active ? "page" : undefined} disabled={navigationBusy || backupBusy}
              onClick={() => navigate(target)}>{label}</Button>;
          })}
        </nav>
        {coin && (page === "images" || page === "sound") ? (
          <span className="ml-auto truncate text-sm text-muted-foreground">{coin.name}</span>
        ) : null}
      </header>

      {error || notice ? <div className="flex items-center justify-between border-b border-border px-5 py-2 text-sm">
        <span className={error ? "text-red-400" : "text-emerald-400"} role={error ? "alert" : "status"}>{error ?? notice}</span>
        <Button variant="ghost" size="sm" onClick={() => { setError(null); setNotice(null); }}>Dismiss</Button>
      </div> : null}

      {page === "catalog" ? <div className="min-h-0 flex-1 overflow-auto p-5">
        {loading ? <p className="text-sm text-muted-foreground">Loading coin library…</p> : <CoinCatalog
          coins={coins} selectedCoinId={coinId} onCreate={createCoin}
          onSelect={(id) => navigate("details", () => selectCoin(id))}
          toolbar={<>
            <Button variant="outline" size="sm" disabled={backupBusy} onClick={() => void runBackup(false)}>Back up library</Button>
            <Button variant="outline" size="sm" disabled={backupBusy} onClick={() => void runBackup(true)}>Restore backup</Button>
          </>}
        />}
      </div> : null}

      {page === "details" ? <div className="min-h-0 flex-1 overflow-auto p-5">
        {coin ? <CoinDetails
          key={coin.id} coin={coin}
          onBack={() => navigate("catalog")} onSound={openSound} onCompare={openImages}
          onChanged={() => refresh(coin.id)}
        /> : <p className="text-sm text-muted-foreground">Loading coin details…</p>}
      </div> : null}

      <section hidden={page !== "sound"} aria-label="Sound analysis" className="min-h-0 flex-1 overflow-auto p-4">
        <SoundWorkspace
          coins={coins} coinId={coinId} references={references} soundRequest={soundRequest}
          onCoinChange={selectCoin} onOpenCoin={openDetails}
          onChanged={refreshAfterWrite} onSaveResult={saveSoundResult}
          onSoundControlsChange={registerSoundControls}
          onCreateCoin={async (name) => {
            const created = await window.coinCatalogApi.createCoin({ name });
            refreshAfterWrite();
            return created.id;
          }}
        />
      </section>

      <section hidden={page !== "images"} aria-label="Image comparison" className="min-h-0 flex-1 overflow-auto p-4">
        <label className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          Catalog coin
          <select value={coinId ?? ""} onChange={(event) => selectCoin(event.target.value ? Number(event.target.value) : null)}
            className="min-w-48 rounded-md border border-border bg-background px-2 py-2 text-foreground">
            <option value="">Select a coin</option>
            {coins.filter((entry) => !entry.archived).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
        <CoinPhotoWorkspace
          key={`${coin?.id ?? "none"}:${photoContext?.sessionId ?? "new"}:${photoContext?.comparison?.id ?? "new"}`}
          coin={coin}
          comparison={photoContext?.comparison}
          requestedSide={requestedSide}
          onOpenCoin={openDetails}
          onImport={async (side) => {
            if (coinId === null) return null;
            const image = await window.coinCatalogApi.importImage({ coinId, side, role: "candidate" });
            if (image) refreshAfterWrite();
            return image ? toComparisonPhoto(image) : null;
          }}
          onSave={async (draft, comparisonId) => {
            if (coinId === null) throw new Error("Select a catalog coin before saving photos.");
            const input = {
              side: draft.side, referenceImageId: draft.referenceImageId, candidateImageId: draft.candidate.id,
              alignment: draft.alignment, notes: draft.notes,
            };
            const saved = comparisonId === undefined
              ? await window.coinCatalogApi.createComparison(await getSession(coinId, photoContext?.sessionId), input)
              : await window.coinCatalogApi.updateComparison(comparisonId, input);
            refreshAfterWrite();
            return saved.id;
          }}
        />
      </section>

      <Dialog open={pendingNavigation !== null} onOpenChange={(open) => {
        if (!open && !navigationBusy) setPendingNavigation(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Finish the current recording?</DialogTitle>
            <DialogDescription>Finish it to keep the analyzed peaks in Sound Analysis, or discard this take before switching workspaces.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={navigationBusy} onClick={() => setPendingNavigation(null)}>Stay</Button>
            <Button variant="outline" disabled={navigationBusy} onClick={() => {
              if (pendingNavigation) void finishNavigation(pendingNavigation, false);
            }}>Discard</Button>
            <Button disabled={navigationBusy} onClick={() => {
              if (pendingNavigation) void finishNavigation(pendingNavigation, true);
            }}>{navigationBusy ? "Finishing…" : "Finish recording"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
