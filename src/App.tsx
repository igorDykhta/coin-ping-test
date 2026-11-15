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
import type { CoinDetail, CoinFace, CoinImage, CoinInput, CoinSummary, ImageComparison as SavedComparison, SoundAudio } from "./types/catalog";
import type { ReferenceRecord } from "./types/coinPing";

type Page = "catalog" | "details" | "sound" | "images";
type PhotoContext = { sessionId: number; comparison?: SavedComparison };
type PhotoRequest = { side: CoinFace; requestId: number };
type PendingNavigation = { action: () => void; changingSpecimen: boolean };
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

function imagePairKey(referenceId: number, candidateId: number) {
  return `${referenceId}:${candidateId}`;
}

function CoinPhotoWorkspace({ coin, comparison, requestedSide, candidateIds, saveAvailable, onOpenCoin, onImport, onDeleteCandidate, onSave }: {
  coin: CoinDetail | null;
  comparison?: SavedComparison;
  requestedSide?: PhotoRequest;
  candidateIds?: ReadonlySet<number>;
  saveAvailable: boolean;
  onOpenCoin: () => void;
  onImport: (side: CoinFace) => Promise<ComparisonPhoto | null>;
  onDeleteCandidate: (id: number) => Promise<void>;
  onSave: (draft: ImageComparisonDraft, comparisonId?: number) => Promise<number>;
}) {
  const photos = coin?.images ?? [];
  const savedPairs = useRef(new Map<string, number>(comparison
    ? [[imagePairKey(comparison.referenceImageId, comparison.candidateImageId), comparison.id]]
    : []));
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
    const matchesRole = image.role === role;
    const inSpecimen = role === "reference" || candidateIds === undefined || candidateIds.has(image.id);
    const photo = matchesRole && inSpecimen ? toComparisonPhoto(image) : null;
    return photo ? [photo] : [];
  });

  return <ImageComparison
    coinName={coin?.name ?? null}
    requestedSide={requestedSide}
    referenceImages={getPhotos("reference")}
    candidateImages={getPhotos("candidate")}
    initial={initial}
    saveAvailable={saveAvailable}
    importCandidate={onImport}
    onDeleteCandidate={onDeleteCandidate}
    onOpenCoin={coin ? onOpenCoin : undefined}
    onSave={async (draft) => {
      const key = imagePairKey(draft.referenceImageId, draft.candidate.id);
      savedPairs.current.set(key, await onSave(draft, savedPairs.current.get(key)));
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
  const [activeSessionId, setActiveSessionId] = useState<number>();
  const activeSessionRef = useRef<number | undefined>(undefined);
  const [specimenName, setSpecimenName] = useState<string | null>(null);
  const [specimenError, setSpecimenError] = useState<string | null>(null);
  const [creatingSpecimen, setCreatingSpecimen] = useState(false);
  const specimenRequest = useRef(false);
  const [photoComparison, setPhotoComparison] = useState<SavedComparison>();
  const [requestedSide, setRequestedSide] = useState<PhotoRequest>();
  const importedCandidates = useRef(new Map<number, Set<number>>());
  const [soundRequest, setSoundRequest] = useState(0);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const soundControls = useRef<SoundControls | null>(null);
  const detailRequest = useRef(0);
  const libraryRequest = useRef(0);
  const coin = coinDetail?.id === coinId ? coinDetail : null;
  const isArchived = coin?.archived ?? coins.find((entry) => entry.id === coinId)?.archived ?? false;
  const soundCoinId = isArchived ? null : coinId;
  const imageCoin = !isArchived || photoComparison ? coin : null;
  const activeSession = coin?.sessions.find((entry) => entry.id === activeSessionId);
  const sessionLabel = activeSessionId === undefined
    ? "No specimen session"
    : activeSession?.label ?? `Test session #${activeSessionId}`;
  const showSessionControls = coin && ((page === "sound" && soundCoinId !== null) || (page === "images" && imageCoin));
  const candidateIds = activeSessionId === undefined ? undefined : new Set([
    ...(importedCandidates.current.get(activeSessionId) ?? []),
    ...(activeSession?.comparisons?.map(({ candidateImageId }) => candidateImageId) ?? []),
  ]);

  const loadCoinDetail = useCallback(async (id: number | null) => {
    const sequence = ++detailRequest.current;
    const isCurrent = () => sequence === detailRequest.current && id === selectedCoinRef.current;
    try {
      const detail = id === null ? null : await window.coinCatalogApi.getCoin(id);
      if (isCurrent()) setCoinDetail(detail);
    } catch (failure) {
      if (isCurrent()) throw failure;
    }
  }, []);

  const refresh = useCallback(async (id = selectedCoinRef.current) => {
    const librarySequence = ++libraryRequest.current;
    const library = Promise.all([
      window.coinCatalogApi.listCoins(),
      window.coinPingApi.listReferences(),
    ]).then(([nextCoins, nextReferences]) => {
      if (librarySequence === libraryRequest.current) {
        setCoins(nextCoins);
        setReferences(nextReferences);
      }
    });
    // A completed edit may belong to a coin the user has already left.
    const detail = id === selectedCoinRef.current ? loadCoinDetail(id) : undefined;
    await Promise.all([library, detail]);
  }, [loadCoinDetail]);

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

  function selectSession(id?: number) {
    activeSessionRef.current = id;
    setActiveSessionId(id);
    setPhotoComparison((previous) => previous?.sessionId === id ? previous : undefined);
  }

  function selectCoin(id: number | null) {
    if (selectedCoinRef.current === id) return;
    selectedCoinRef.current = id;
    setCoinId(id);
    setCoinDetail(null);
    selectSession();
    setRequestedSide(undefined);
    void loadCoinDetail(id).catch((failure: unknown) => {
      if (id === selectedCoinRef.current) setError(errorMessage(failure));
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

  function navigate(next: Page, action?: () => void, changingSpecimen = false) {
    if (navigationBusy || specimenRequest.current) return;
    const open = () => {
      setError(null);
      setNotice(null);
      action?.();
      setPage(next);
    };
    if (page !== "sound" || (next === "sound" && !changingSpecimen)) {
      open();
    } else if (soundControls.current?.isRecording) {
      setPendingNavigation({ action: open, changingSpecimen });
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
      if (sessionId !== undefined) selectSession(sessionId);
      setSoundRequest((prior) => prior + 1);
    });
  }

  function openImages(side?: CoinFace, context?: PhotoContext) {
    navigate("images", () => {
      if (context) selectSession(context.sessionId);
      setPhotoComparison(context?.comparison);
      if (side) setRequestedSide((prior) => ({ side, requestId: (prior?.requestId ?? 0) + 1 }));
    });
  }

  function startSpecimen() {
    if (!coin || coin.archived || navigationBusy || specimenRequest.current) return;
    const open = () => {
      setSpecimenName("");
      setSpecimenError(null);
    };
    if (page === "sound" && soundControls.current?.isRecording) navigate(page, open, true);
    else open();
  }

  async function createSpecimen() {
    if (!coin || coin.archived || specimenName === null || specimenRequest.current) return;
    const label = specimenName.trim();
    if (!label) {
      setSpecimenError("Enter a name for this specimen.");
      return;
    }
    specimenRequest.current = true;
    setCreatingSpecimen(true);
    setSpecimenError(null);
    try {
      if (page === "sound") await soundControls.current?.stopListening();
      const session = await window.coinCatalogApi.createSession(coin.id, { label });
      if (selectedCoinRef.current === coin.id) {
        setCoinDetail((previous) => previous?.id === coin.id
          ? { ...previous, sessions: [session, ...previous.sessions] }
          : previous);
        selectSession(session.id);
      }
      setSpecimenName(null);
      refreshAfterWrite();
    } catch (failure) {
      setSpecimenError(errorMessage(failure));
    } finally {
      specimenRequest.current = false;
      setCreatingSpecimen(false);
    }
  }

  function requireSpecimen(destinationCoinId: number): number {
    if (activeSessionId === undefined) throw new Error("Start or select a specimen session before saving a test.");
    if (activeSessionRef.current !== activeSessionId || selectedCoinRef.current !== destinationCoinId) {
      throw new Error("The specimen session changed before the test could be saved.");
    }
    return activeSessionId;
  }

  async function saveSoundResult(ping: DetectedPing, matches: ReferenceMatch[], audio?: SoundAudio) {
    if (soundCoinId === null) throw new Error("Select an active catalog coin before saving a sound result.");
    const sessionId = requireSpecimen(soundCoinId);
    await window.coinCatalogApi.saveSoundResult(sessionId, {
      label: `Sound · ${new Date(ping.detectedAt).toLocaleString()}`,
      peaks: ping.peaks,
      matches: matches.map(({ reference, score }) => {
        const matchedCoin = coins.find((row) => row.id === reference.coinId);
        return { referenceId: reference.id, label: matchedCoin ? `${matchedCoin.name} · ${reference.label}` : reference.label, score };
      }),
    }, audio);
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
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-5 py-3">
        <span className="whitespace-nowrap text-sm font-semibold tracking-wide">Coin Ping Analyzer</span>
        <nav aria-label="Workspaces" className="flex gap-1">
          {TABS.map(([target, label]) => {
            const active = page === target || (target === "catalog" && page === "details");
            return <Button key={target} size="sm" variant={active ? "secondary" : "ghost"}
              aria-current={active ? "page" : undefined} disabled={navigationBusy || backupBusy || creatingSpecimen}
              onClick={() => navigate(target)}>{label}</Button>;
          })}
        </nav>
        {showSessionControls ? (
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span className="max-w-48 truncate text-sm text-muted-foreground" title={`${coin.name} · ${sessionLabel}`}>
              {coin.name} · {sessionLabel}
            </span>
            {!coin.archived && <>
              <select aria-label="Specimen session" value={activeSessionId ?? ""} disabled={navigationBusy || creatingSpecimen}
                onChange={(event) => {
                  const id = event.target.value ? Number(event.target.value) : undefined;
                  navigate(page, () => selectSession(id), true);
                }}
                className="max-w-40 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground">
                <option value="">No specimen session</option>
                {coin.sessions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
              <Button size="sm" variant="outline" disabled={navigationBusy || creatingSpecimen} onClick={startSpecimen}>Start new specimen test</Button>
            </>}
          </div>
        ) : null}
      </header>

      {error || notice ? <div className="flex items-center justify-between border-b border-border px-5 py-2 text-sm">
        <span className={error ? "text-red-400" : "text-emerald-400"} role={error ? "alert" : "status"}>{error ?? notice}</span>
        <Button variant="ghost" size="sm" onClick={() => { setError(null); setNotice(null); }}>Dismiss</Button>
      </div> : null}

      <div hidden={page !== "catalog"} className="min-h-0 flex-1 overflow-auto p-5">
        {loading ? <p className="text-sm text-muted-foreground">Loading coin library…</p> : <CoinCatalog
          coins={coins} selectedCoinId={coinId} onCreate={createCoin}
          onSelect={(id) => navigate("details", () => selectCoin(id))}
          toolbar={<>
            <Button variant="outline" size="sm" disabled={backupBusy} onClick={() => void runBackup(false)}>Back up library</Button>
            <Button variant="outline" size="sm" disabled={backupBusy} onClick={() => void runBackup(true)}>Restore backup</Button>
          </>}
        />}
      </div>

      {page === "details" ? <div className="min-h-0 flex-1 overflow-auto p-5">
        {coin ? <CoinDetails
          key={coin.id} coin={coin}
          onBack={() => navigate("catalog")} onSound={openSound} onCompare={openImages}
          onStartSpecimen={startSpecimen} activeSessionId={activeSessionId}
          onChanged={() => refresh(coin.id)}
        /> : <p className="text-sm text-muted-foreground">Loading coin details…</p>}
      </div> : null}

      <section hidden={page !== "sound"} aria-label="Sound analysis" className="min-h-0 flex-1 overflow-auto p-4">
        <SoundWorkspace
          key={`${soundCoinId ?? "none"}:${activeSessionId ?? "none"}`}
          coins={coins} coinId={soundCoinId} references={references} soundRequest={soundRequest}
          sessionId={activeSessionId}
          onCoinChange={(id) => navigate("sound", () => selectCoin(id), true)} onOpenCoin={openDetails}
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
          <select value={imageCoin?.id ?? ""} onChange={(event) => selectCoin(event.target.value ? Number(event.target.value) : null)}
            className="min-w-48 rounded-md border border-border bg-background px-2 py-2 text-foreground">
            <option value="">Select a coin</option>
            {imageCoin?.archived ? <option value={imageCoin.id} disabled>{imageCoin.name} (Archived)</option> : null}
            {coins.filter((entry) => !entry.archived).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
        <CoinPhotoWorkspace
          key={`${imageCoin?.id ?? "none"}:${activeSessionId ?? "new"}:${photoComparison?.id ?? "new"}`}
          coin={imageCoin}
          comparison={photoComparison}
          requestedSide={requestedSide}
          candidateIds={candidateIds}
          saveAvailable={imageCoin !== null && activeSessionId !== undefined}
          onOpenCoin={openDetails}
          onImport={async (side) => {
            if (!imageCoin) return null;
            const image = await window.coinCatalogApi.importImage({ coinId: imageCoin.id, side, role: "candidate" });
            if (image) {
              if (activeSessionId !== undefined) {
                const imports = importedCandidates.current.get(activeSessionId) ?? new Set<number>();
                imports.add(image.id);
                importedCandidates.current.set(activeSessionId, imports);
              }
              refreshAfterWrite();
            }
            return image ? toComparisonPhoto(image) : null;
          }}
          onDeleteCandidate={async (id) => {
            await window.coinCatalogApi.deleteImage(id);
            refreshAfterWrite();
          }}
          onSave={async (draft, comparisonId) => {
            if (!imageCoin) throw new Error("Select a catalog coin before saving photos.");
            const sessionId = requireSpecimen(imageCoin.id);
            const input = {
              side: draft.side, referenceImageId: draft.referenceImageId, candidateImageId: draft.candidate.id,
              alignment: draft.alignment, notes: draft.notes,
            };
            const saved = comparisonId === undefined
              ? await window.coinCatalogApi.createComparison(sessionId, input)
              : await window.coinCatalogApi.updateComparison(comparisonId, input);
            refreshAfterWrite();
            return saved.id;
          }}
        />
      </section>

      <Dialog open={specimenName !== null} onOpenChange={(open) => {
        if (!open && !specimenRequest.current) setSpecimenName(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start new specimen test</DialogTitle>
            <DialogDescription>Give this specimen a name to keep its test results together.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void createSpecimen(); }}>
            <label className="grid gap-1 text-sm">
              Specimen name
              <input autoFocus required value={specimenName ?? ""} disabled={creatingSpecimen}
                className="w-full rounded-md border border-border bg-background px-2 py-2"
                onChange={(event) => setSpecimenName(event.target.value)} />
            </label>
            {specimenError && <p role="alert" className="text-sm text-red-400">{specimenError}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={creatingSpecimen} onClick={() => setSpecimenName(null)}>Cancel</Button>
              <Button type="submit" disabled={creatingSpecimen}>{creatingSpecimen ? "Creating…" : "Create specimen session"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingNavigation !== null} onOpenChange={(open) => {
        if (!open && !navigationBusy) setPendingNavigation(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingNavigation?.changingSpecimen ? "Discard the current recording?" : "Finish the current recording?"}</DialogTitle>
            <DialogDescription>{pendingNavigation?.changingSpecimen
              ? "Stay to finish this take, or discard it before changing the test destination."
              : "Finish it to keep the analyzed peaks in Sound Analysis, or discard this take before switching workspaces."}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={navigationBusy} onClick={() => setPendingNavigation(null)}>Stay</Button>
            <Button variant="outline" disabled={navigationBusy} onClick={() => {
              if (pendingNavigation) void finishNavigation(pendingNavigation.action, false);
            }}>Discard</Button>
            {!pendingNavigation?.changingSpecimen && <Button disabled={navigationBusy} onClick={() => {
              if (pendingNavigation) void finishNavigation(pendingNavigation.action, true);
            }}>{navigationBusy ? "Finishing…" : "Finish recording"}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
