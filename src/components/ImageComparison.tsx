import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Button, Input, Label } from "@sqlrooms/ui";

import { clamp, INITIAL_ALIGNMENT, layerOffset, viewPoint } from "../lib/imageAlignment";
import type { CoinFace as Face, ImageAlignment } from "../types/catalog";
import "./ImageComparison.css";

type Layer = "reference" | "candidate";
type Tool = "align" | "pan";

export type ComparisonPhoto = {
  id: number;
  side: Face;
  name: string;
  url: string;
  primary?: boolean;
};

export type ImageComparisonDraft = {
  side: Face;
  referenceImageId: number;
  candidate: ComparisonPhoto;
  alignment: ImageAlignment;
  notes: string;
};

type Props = {
  coinName: string | null;
  referenceImages: readonly ComparisonPhoto[];
  candidateImages?: readonly ComparisonPhoto[];
  requestedSide?: { side: Face; requestId: number };
  importCandidate: (side: Face) => Promise<ComparisonPhoto | null>;
  onDeleteCandidate?: (id: number) => Promise<void>;
  onSave: (draft: ImageComparisonDraft) => Promise<void>;
  initial?: ImageComparisonDraft | null;
  onOpenCoin?: () => void;
};

type FaceDraft = {
  referenceImageId?: number;
  candidate?: ComparisonPhoto;
  alignment: ImageAlignment;
  history: ImageAlignment[];
  notes: string;
  saved: boolean;
};

function newFaceDraft(): FaceDraft {
  return { alignment: INITIAL_ALIGNMENT, history: [], notes: "", saved: false };
}

function loadDrafts(initial?: ImageComparisonDraft | null): Record<Face, FaceDraft> {
  const drafts = { obverse: newFaceDraft(), reverse: newFaceDraft() };
  if (initial) {
    drafts[initial.side] = {
      referenceImageId: initial.referenceImageId,
      candidate: initial.candidate,
      alignment: initial.alignment,
      history: [],
      notes: initial.notes,
      saved: true,
    };
  }
  return drafts;
}

type NumberFieldProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
};

function NumberField({ label, value, min, max, step = 1, disabled, onCommit }: NumberFieldProps) {
  const format = (number: number) => String(Number(number.toFixed(2)));
  const formatted = format(value);
  const [draft, setDraft] = useState(formatted);
  useEffect(() => setDraft(formatted), [formatted]);

  return (
    <label className="coin-compare-field">
      <span>{label}</span>
      <Input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={() => {
          const numeric = Number(draft);
          const next = draft.trim() && Number.isFinite(numeric) ? clamp(numeric, min, max) : value;
          setDraft(format(next));
          if (next !== value && draft !== formatted) onCommit(next);
        }}
      />
    </label>
  );
}

type RangeFieldProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number, remember: boolean) => void;
};

function RangeField({ label, value, min, max, step, disabled, onChange }: RangeFieldProps) {
  const drag = useRef<"start" | "changed" | null>(null);
  return (
    <label className="coin-compare-range">
      <span>{label} <output>{Math.round(value * 100)}%</output></span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={() => { drag.current = "start"; }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}
        onBlur={() => { drag.current = null; }}
        onChange={(event) => {
          onChange(event.currentTarget.valueAsNumber, drag.current !== "changed");
          if (drag.current === "start") drag.current = "changed";
        }}
      />
    </label>
  );
}

type PaneProps = {
  photos: Record<Layer, ComparisonPhoto | undefined>;
  layers: readonly Layer[];
  alignment: ImageAlignment;
  stageSize: number;
  label?: string;
  adjustable?: boolean;
};

function ComparisonPane({ photos, layers, alignment, stageSize, label, adjustable }: PaneProps) {
  const diameter = 2 * alignment.rimRadius * stageSize * alignment.zoom;
  const guidePosition = viewPoint({ x: alignment.guideX ?? 0, y: alignment.guideY ?? 0 }, alignment, stageSize);
  const hasPhoto = layers.some((layer) => photos[layer]);
  return (
    <div className="coin-compare-pane" data-adjustable={adjustable || undefined}>
      {label && <span className="coin-compare-pane-label">{label}</span>}
      {layers.map((layer) => {
        const photo = photos[layer];
        if (!photo) return null;
        const transform = alignment[layer];
        const { left, top } = viewPoint(transform, alignment, stageSize);
        const size = 0.86 * stageSize * alignment.zoom * transform.scale;
        return (
          <img
            key={photo.id + "-" + layer}
            className="coin-compare-photo"
            alt={layer === "reference" ? "Reference coin" : "Candidate coin"}
            src={photo.url}
            draggable={false}
            style={{
              left: `calc(50% + ${left}px)`,
              top: `calc(50% + ${top}px)`,
              width: size,
              height: size,
              transform: `translate(-50%, -50%) rotate(${transform.rotation}deg)`,
              opacity: alignment.view === "overlay" && layer === "candidate" && photos.reference
                ? alignment.opacity
                : 1,
            }}
          />
        );
      })}
      {hasPhoto && alignment.guides && (
        <span
          className="coin-compare-guide"
          aria-hidden="true"
          style={{
            left: `calc(50% + ${guidePosition.left}px)`,
            top: `calc(50% + ${guidePosition.top}px)`,
            width: diameter,
            height: diameter,
          }}
        />
      )}
      {!hasPhoto && (
        <p className="coin-compare-stage-empty">
          {layers.length === 2 ? "Choose a reference and open a photo" : `No ${layers[0]} photo`}
        </p>
      )}
    </div>
  );
}

type DragState = {
  pointerId: number;
  face: Face;
  clientX: number;
  clientY: number;
  target: Layer | "pan";
  alignment: ImageAlignment;
  stageSize: number;
  moved: boolean;
};

const VIEW_OPTIONS: { label: string; value: ImageAlignment["view"] }[] = [
  { label: "Overlay", value: "overlay" },
  { label: "Side by side", value: "side-by-side" },
  { label: "Alternate", value: "alternate" },
];

export function ImageComparison({
  coinName,
  referenceImages,
  candidateImages = [],
  requestedSide,
  importCandidate,
  onDeleteCandidate,
  onSave,
  initial,
  onOpenCoin,
}: Props) {
  const [side, setSide] = useState<Face>(() => {
    if (requestedSide) return requestedSide.side;
    if (initial) return initial.side;
    return referenceImages.some((photo) => photo.side === "obverse") || !referenceImages.length ? "obverse" : "reverse";
  });
  const [drafts, setDrafts] = useState(() => loadDrafts(initial));
  const [selectedLayer, setSelectedLayer] = useState<Layer>("candidate");
  const [tool, setTool] = useState<Tool>("align");
  const [pending, setPending] = useState<"import" | "save" | "delete" | null>(null);
  const [removedCandidateIds, setRemovedCandidateIds] = useState<ReadonlySet<number>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [stageBounds, setStageBounds] = useState({ width: 0, height: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const draft = drafts[side];
  const { alignment } = draft;
  const candidates = candidateImages.filter((photo) => photo.side === side && !removedCandidateIds.has(photo.id));
  const activeCandidate = draft.candidate;
  if (activeCandidate && !candidates.some((photo) => photo.id === activeCandidate.id)) {
    candidates.unshift(activeCandidate);
  }
  const references = referenceImages.filter((photo) => photo.side === side);
  const reference = references.find((photo) => photo.id === draft.referenceImageId)
    ?? references.find((photo) => photo.primary)
    ?? references[0];
  const photos = { reference, candidate: draft.candidate };
  const stageSize = Math.min(
    stageBounds.width / (alignment.view === "side-by-side" ? 2 : 1),
    stageBounds.height,
  );
  const otherLayer = selectedLayer === "reference" ? "candidate" : "reference";
  const alternating = alignment.view === "alternate";
  const activeLayer = alternating && !photos[selectedLayer] && photos[otherLayer] ? otherLayer : selectedLayer;
  const layer = alignment[activeLayer];
  const canAlternate = !!(photos.reference && photos.candidate);
  const canAdjust = (target: Layer) => !!photos[target] && (target !== "reference" || !alignment.locked);
  const canAlign = canAdjust(activeLayer);
  const alignMode = alignment.view === "side-by-side" ? "align-panes" : canAlign ? "align" : undefined;
  const requestedFace = requestedSide?.side;
  const sideRequestId = requestedSide?.requestId;

  useEffect(() => {
    if (requestedFace) {
      setSide(requestedFace);
      setErrorMessage(null);
    }
  }, [requestedFace, sideRequestId]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      setStageBounds({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [coinName]);

  function updateDraft(face: Face, update: (old: FaceDraft) => FaceDraft) {
    setDrafts((old) => ({ ...old, [face]: update(old[face]) }));
  }

  function changeAlignment(
    change: (old: ImageAlignment) => ImageAlignment,
    face = side,
    checkpoint?: ImageAlignment | false,
  ) {
    updateDraft(face, (old) => ({
      ...old,
      alignment: change(old.alignment),
      saved: false,
      history: checkpoint === false
        ? old.history
        : [...old.history.slice(-39), checkpoint ?? old.alignment],
    }));
    setErrorMessage(null);
  }

  function undo() {
    updateDraft(side, (old) => {
      const last = old.history.at(-1);
      return last ? { ...old, alignment: last, history: old.history.slice(0, -1), saved: false } : old;
    });
    setErrorMessage(null);
  }

  function adjustLayer(patch: Partial<ImageAlignment[Layer]>) {
    changeAlignment((old) => ({ ...old, [activeLayer]: { ...old[activeLayer], ...patch } }));
  }

  function alternate() {
    if (canAlternate) setSelectedLayer(activeLayer === "candidate" ? "reference" : "candidate");
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || pending || stageSize <= 0 || dragRef.current) return;
    let target: Layer | "pan" = tool === "pan" ? "pan" : activeLayer;
    if (target !== "pan" && alignment.view === "side-by-side") {
      const { left, width } = event.currentTarget.getBoundingClientRect();
      target = event.clientX < left + width / 2 ? "reference" : "candidate";
      if (photos[target]) setSelectedLayer(target);
    }
    event.currentTarget.focus({ preventScroll: true });
    if (target !== "pan" && !canAdjust(target)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      face: side,
      clientX: event.clientX,
      clientY: event.clientY,
      target,
      alignment,
      stageSize,
      moved: false,
    };
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    if (!drag.moved && !dx && !dy) return;
    const offset = layerOffset(drag.alignment[drag.target], dx, dy, drag.stageSize, drag.alignment.zoom);
    changeAlignment(
      (old) => ({ ...old, [drag.target]: { ...old[drag.target], ...offset } }),
      drag.face,
      drag.moved ? false : drag.alignment,
    );
    drag.moved = true;
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  function onStageKey(event: KeyboardEvent<HTMLDivElement>) {
    if (pending) return;
    if (event.key === " " && alternating && canAlternate) {
      event.preventDefault();
      if (!event.repeat) alternate();
      return;
    }
    const directions: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const direction = directions[event.key];
    if (!direction || stageSize <= 0 || (tool === "align" && !canAlign)) return;
    event.preventDefault();
    const [dx, dy] = direction;
    const target = tool === "pan" ? "pan" : activeLayer;
    const step = event.shiftKey ? 10 : 1;
    const offset = layerOffset(alignment[target], dx * step, dy * step, stageSize, alignment.zoom);
    changeAlignment((old) => ({ ...old, [target]: { ...old[target], ...offset } }));
  }

  function selectCandidate(photo?: ComparisonPhoto) {
    updateDraft(side, (old) => {
      if (old.candidate?.id === photo?.id) return old;
      return {
        ...old,
        candidate: photo,
        alignment: { ...old.alignment, candidate: INITIAL_ALIGNMENT.candidate },
        history: [],
        notes: old.saved ? "" : old.notes,
        saved: false,
      };
    });
    setSelectedLayer("candidate");
    setErrorMessage(null);
  }

  async function openCandidate() {
    setPending("import");
    setErrorMessage(null);
    try {
      const photo = await importCandidate(side);
      if (photo) selectCandidate(photo);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to open photo.");
    } finally {
      setPending(null);
    }
  }

  async function removeCandidate() {
    const candidate = draft.candidate;
    if (pending || !onDeleteCandidate || !candidate) return;
    if (!window.confirm(`Remove "${candidate.name}" from this coin's candidate photos?`)) return;

    setPending("delete");
    setErrorMessage(null);
    try {
      await onDeleteCandidate(candidate.id);
      // The refreshed list can arrive after the deletion completes.
      setRemovedCandidateIds((previous) => new Set([...previous, candidate.id]));
      selectCandidate();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to remove photo.");
    } finally {
      setPending(null);
    }
  }

  async function save() {
    if (!reference || !draft.candidate) return;
    setPending("save");
    setErrorMessage(null);
    try {
      await onSave({
        side,
        referenceImageId: reference.id,
        candidate: draft.candidate,
        alignment,
        notes: draft.notes,
      });
      updateDraft(side, (old) => ({ ...old, referenceImageId: reference.id, saved: true }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to save comparison.");
    } finally {
      setPending(null);
    }
  }

  if (!coinName) {
    return (
      <section className="coin-compare-no-selection" aria-label="Image comparison">
        <h1>Image comparison</h1>
        <p>Choose a coin from the catalog to compare its reference photos.</p>
        {onOpenCoin && <Button onClick={onOpenCoin}>Open catalog</Button>}
      </section>
    );
  }

  return (
    <section className="coin-compare" aria-labelledby="coin-comparison-title">
      <header className="coin-compare-header">
        <div>
          <h1 id="coin-comparison-title">Image comparison</h1>
          {onOpenCoin ? (
            <Button variant="link" className="h-auto px-0 py-0" onClick={onOpenCoin}>{coinName}</Button>
          ) : <p>{coinName}</p>}
        </div>
        <div className="coin-compare-actions">
          <Button variant="outline" disabled={!!pending} onClick={() => void openCandidate()}>
            {pending === "import" ? "Opening…" : draft.candidate ? "Replace photo" : "Open photo"}
          </Button>
          {reference && draft.candidate && (
            <span role="status" className="coin-compare-save-status">{draft.saved ? "Saved" : "Unsaved"}</span>
          )}
          <Button disabled={!reference || !draft.candidate || !!pending || draft.saved} onClick={() => void save()}>
            {pending === "save" ? "Saving…" : "Save comparison"}
          </Button>
        </div>
      </header>

      <div className="coin-compare-workspace">
        <div className="coin-compare-view">
          <div className="coin-compare-view-toolbar">
            <div className="coin-compare-actions" aria-label="Comparison view">
              {VIEW_OPTIONS.map(({ label, value }) => (
                <Button
                  key={value}
                  size="sm"
                  variant={alignment.view === value ? "secondary" : "ghost"}
                  aria-pressed={alignment.view === value}
                  disabled={!!pending}
                  onClick={() => changeAlignment((old) => ({ ...old, view: value }))}
                >{label}</Button>
              ))}
            </div>
            <div className="coin-compare-actions">
              {alternating && canAlternate && (
                <Button size="sm" variant="outline" onClick={alternate}>
                  Show {activeLayer === "reference" ? "candidate" : "reference"}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                aria-pressed={tool === "pan"}
                disabled={!!pending}
                onClick={() => setTool((old) => old === "pan" ? "align" : "pan")}
              >Pan view</Button>
            </div>
          </div>
          <div
            className="coin-compare-stage"
            data-view={alignment.view}
            data-tool={tool === "pan" ? "pan" : alignMode}
            ref={stageRef}
            tabIndex={0}
            role="region"
            aria-label="Photo comparison. Drag or use arrow keys to move the active layer or pan the view."
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={onStageKey}
          >
            {alignment.view === "side-by-side" ? (
              <>
                <ComparisonPane label="Reference" photos={photos} layers={["reference"]} alignment={alignment} stageSize={stageSize} adjustable={canAdjust("reference")} />
                <ComparisonPane label="Candidate" photos={photos} layers={["candidate"]} alignment={alignment} stageSize={stageSize} adjustable={canAdjust("candidate")} />
              </>
            ) : (
              <ComparisonPane
                label={alternating ? activeLayer === "reference" ? "Reference" : "Candidate" : undefined}
                photos={photos}
                layers={alternating ? [activeLayer] : ["reference", "candidate"]}
                alignment={alignment}
                stageSize={stageSize}
              />
            )}
          </div>
          <div className="coin-compare-view-footer">
            <RangeField
              label="View zoom"
              min={0.25}
              max={8}
              step={0.05}
              value={alignment.zoom}
              disabled={!!pending}
              onChange={(zoom, remember) => changeAlignment((old) => ({ ...old, zoom }), side, remember ? undefined : false)}
            />
            <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => changeAlignment((old) => ({ ...old, zoom: 1, pan: { x: 0, y: 0 } }))}>
              Reset view
            </Button>
          </div>
        </div>

        <aside className="coin-compare-options" aria-label="Comparison controls">
          <fieldset disabled={!!pending}>
            <legend>Photos</legend>
            <div className="coin-compare-actions" aria-label="Coin side">
              {(["obverse", "reverse"] as const).map((face) => (
                <Button
                  key={face}
                  size="sm"
                  aria-pressed={side === face}
                  variant={side === face ? "secondary" : "outline"}
                  onClick={() => { setSide(face); setErrorMessage(null); }}
                >{face === "obverse" ? "Obverse" : "Reverse"}</Button>
              ))}
            </div>
            <label className="coin-compare-field">
              <span>Reference photo</span>
              <select
                disabled={!references.length}
                value={reference?.id ?? ""}
                onChange={(event) => {
                  const referenceImageId = Number(event.currentTarget.value);
                  updateDraft(side, (old) => ({
                    ...old,
                    referenceImageId,
                    alignment: { ...old.alignment, reference: INITIAL_ALIGNMENT.reference },
                    history: [],
                    saved: false,
                  }));
                  setErrorMessage(null);
                }}
              >
                {!references.length && <option value="">No reference for this side</option>}
                {references.map((photo) => <option key={photo.id} value={photo.id}>{photo.name}</option>)}
              </select>
            </label>
            <label className="coin-compare-field">
              <span>Candidate photo</span>
              <select
                disabled={!candidates.length}
                value={draft.candidate?.id ?? ""}
                onChange={(event) => {
                  const id = Number(event.currentTarget.value);
                  selectCandidate(candidates.find((photo) => photo.id === id));
                }}
              >
                <option value="">No photo open</option>
                {candidates.map((photo) => <option key={photo.id} value={photo.id}>{photo.name}</option>)}
              </select>
            </label>
            {draft.candidate && onDeleteCandidate && (
              <Button size="sm" variant="outline" disabled={!!pending} onClick={() => void removeCandidate()}>
                {pending === "delete" ? "Removing…" : "Remove candidate photo"}
              </Button>
            )}
          </fieldset>

          <fieldset disabled={!!pending}>
            <legend>Alignment</legend>
            <div className="coin-compare-actions" aria-label="Layer to adjust">
              {(["reference", "candidate"] as const).map((target) => (
                <Button
                  key={target}
                  size="sm"
                  aria-pressed={activeLayer === target}
                  variant={activeLayer === target ? "secondary" : "outline"}
                  disabled={!photos[target]}
                  onClick={() => {
                    setSelectedLayer(target);
                    setTool("align");
                  }}
                >{target === "reference" ? "Reference" : "Candidate"}</Button>
              ))}
            </div>
            <Label className="coin-compare-check">
              <input type="checkbox" checked={alignment.locked} onChange={(event) => {
                const locked = event.currentTarget.checked;
                changeAlignment((old) => ({ ...old, locked }));
              }} />
              Lock reference
            </Label>
            {activeLayer === "reference" && photos.reference && alignment.locked && (
              <p className="coin-compare-field text-muted-foreground">Unlock the reference to adjust it.</p>
            )}
            <div className="coin-compare-fields">
              <NumberField label="X offset (%)" value={layer.x * 100} min={-1000} max={1000} step={0.1} disabled={!canAlign} onCommit={(x) => adjustLayer({ x: x / 100 })} />
              <NumberField label="Y offset (%)" value={layer.y * 100} min={-1000} max={1000} step={0.1} disabled={!canAlign} onCommit={(y) => adjustLayer({ y: y / 100 })} />
              <NumberField label="Rotation (°)" value={layer.rotation} min={-180} max={180} step={0.1} disabled={!canAlign} onCommit={(rotation) => adjustLayer({ rotation })} />
              <NumberField label="Scale (%)" value={layer.scale * 100} min={10} max={600} step={0.1} disabled={!canAlign} onCommit={(scale) => adjustLayer({ scale: scale / 100 })} />
            </div>
            {alignment.view === "overlay" && (
              <RangeField
                label="Candidate opacity"
                min={0}
                max={1}
                step={0.01}
                value={alignment.opacity}
                onChange={(opacity, remember) => changeAlignment((old) => ({ ...old, opacity }), side, remember ? undefined : false)}
              />
            )}
            <div className="coin-compare-actions">
              <Button size="sm" variant="outline" disabled={!draft.history.length} onClick={undo}>Undo</Button>
              <Button size="sm" variant="ghost" onClick={() => changeAlignment((old) => ({
                ...old,
                reference: INITIAL_ALIGNMENT.reference,
                candidate: INITIAL_ALIGNMENT.candidate,
              }))}>Reset alignment</Button>
            </div>
          </fieldset>

          <fieldset disabled={!!pending}>
            <legend>Guides</legend>
            <Label className="coin-compare-check">
              <input type="checkbox" checked={alignment.guides} onChange={(event) => {
                const guides = event.currentTarget.checked;
                changeAlignment((old) => ({ ...old, guides }));
              }} />
              Show center and rim
            </Label>
            {alignment.guides && (
              <div className="coin-compare-fields">
                <NumberField label="Center X (%)" value={(alignment.guideX ?? 0) * 100} min={-1000} max={1000} step={0.1} onCommit={(x) => changeAlignment((old) => ({ ...old, guideX: x / 100 }))} />
                <NumberField label="Center Y (%)" value={(alignment.guideY ?? 0) * 100} min={-1000} max={1000} step={0.1} onCommit={(y) => changeAlignment((old) => ({ ...old, guideY: y / 100 }))} />
                <NumberField label="Rim radius (%)" value={alignment.rimRadius * 100} min={2} max={200} step={0.1} onCommit={(radius) => changeAlignment((old) => ({ ...old, rimRadius: radius / 100 }))} />
              </div>
            )}
          </fieldset>

          <label className="coin-compare-field">
            <span>Notes</span>
            <textarea
              rows={3}
              value={draft.notes}
              disabled={!!pending}
              placeholder="Describe the details you compared"
              onChange={(event) => {
                const notes = event.currentTarget.value;
                updateDraft(side, (old) => ({ ...old, notes, saved: false }));
                setErrorMessage(null);
              }}
            />
          </label>
          {errorMessage && <p role="alert" className="text-red-400">{errorMessage}</p>}
        </aside>
      </div>
    </section>
  );
}
