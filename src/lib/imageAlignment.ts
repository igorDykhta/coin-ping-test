import type { ImageAlignment } from "../types/catalog";

export const IDENTITY_LAYER: ImageAlignment["reference"] = {
  x: 0,
  y: 0,
  rotation: 0,
  scale: 1,
};

export const INITIAL_ALIGNMENT: ImageAlignment = {
  reference: IDENTITY_LAYER,
  candidate: IDENTITY_LAYER,
  opacity: 0.5,
  view: "overlay",
  locked: true,
  guides: true,
  rimRadius: 0.33,
  guideX: 0,
  guideY: 0,
  zoom: 1,
  pan: { x: 0, y: 0 },
};

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function layerOffset(
  start: { x: number; y: number },
  dx: number,
  dy: number,
  stageSize: number,
  zoom: number,
): { x: number; y: number } {
  const pixelsPerUnit = stageSize * zoom;
  if (pixelsPerUnit <= 0) return start;
  return {
    x: clamp(start.x + dx / pixelsPerUnit, -10, 10),
    y: clamp(start.y + dy / pixelsPerUnit, -10, 10),
  };
}

export function viewPoint(
  point: { x: number; y: number },
  alignment: ImageAlignment,
  stageSize: number,
): { left: number; top: number } {
  return {
    left: (point.x + alignment.pan.x) * stageSize * alignment.zoom,
    top: (point.y + alignment.pan.y) * stageSize * alignment.zoom,
  };
}
