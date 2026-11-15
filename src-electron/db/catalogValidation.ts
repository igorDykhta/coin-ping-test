import { types } from "node:util";
import type { ComparisonInput, CoinInput, ImageAlignment, LayerTransform, Metric, SoundAudio, SpecificationInput } from "../../src/types/catalog.js";
import type { ResonancePeak } from "../../src/types/coinPing.js";

export class ValidationError extends Error {}

export const MAX_SOUND_AUDIO_BYTES = 16 * 1024 * 1024;
export const SOUND_AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"];

export function validSoundAudio(input: SoundAudio): SoundAudio {
  requireObject(input, "Sound recording");
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.split(";", 1)[0].trim().toLowerCase() : "";
  if (!SOUND_AUDIO_TYPES.includes(mimeType)) {
    throw new ValidationError("Unsupported sound recording format.");
  }
  if (!types.isUint8Array(input.bytes) || input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_SOUND_AUDIO_BYTES) {
    throw new ValidationError("Sound recording must contain audio data and be at most 16 MiB.");
  }
  return { mimeType, bytes: input.bytes };
}

export function requireObject(input: unknown, label: string): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError(`${label} is required.`);
  }
}

export function optionalText(value: unknown, label: string, maxLength = 500): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new ValidationError(`${label} must be text with at most ${maxLength} characters.`);
  }
  return value.trim() || null;
}

export function requiredText(value: unknown, label: string): string {
  const text = optionalText(value, label, 200);
  if (!text) throw new ValidationError(`${label} is required.`);
  return text;
}

export function positiveId(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(`${label} must be a valid ID.`);
  }
  return value;
}

function optionalYear(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > 9999 || value === 0) {
    throw new ValidationError("Enter a whole, nonzero year (negative for BCE).");
  }
  return value;
}

export function coinValues(input: CoinInput) {
  requireObject(input, "Coin");
  const yearFrom = optionalYear(input.yearFrom);
  const yearTo = optionalYear(input.yearTo);
  if (yearTo !== null && (yearFrom === null || yearTo < yearFrom)) {
    throw new ValidationError("Enter a start year no later than the end year.");
  }
  return [
    requiredText(input.name, "Coin name"),
    optionalText(input.country, "Country"),
    optionalText(input.denomination, "Denomination"),
    yearFrom,
    yearTo,
    optionalText(input.mint, "Mint"),
    optionalText(input.variant, "Variant"),
    optionalText(input.composition, "Composition"),
    optionalText(input.notes, "Notes", 10_000),
  ];
}

export function validMetric(metric: unknown): Metric {
  if (metric === "weight" || metric === "density" || metric === "conductivity") return metric;
  throw new ValidationError("Choose weight, density, or conductivity.");
}

export function metricValue(metric: Metric, value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      (metric !== "conductivity" && value === 0)) {
    throw new ValidationError(`${label} must be a valid ${metric} value.`);
  }
  return value;
}

export function specificationValues(input: SpecificationInput) {
  requireObject(input, "Specification");
  const metric = validMetric(input.metric);
  const nominal = input.nominal == null ? null : metricValue(metric, input.nominal, "Nominal value");
  const min = input.min == null ? null : metricValue(metric, input.min, "Minimum");
  const max = input.max == null ? null : metricValue(metric, input.max, "Maximum");
  if (nominal === null && min === null && max === null) {
    throw new ValidationError("Enter a nominal value or an acceptable range.");
  }
  if (min !== null && max !== null && min > max) {
    throw new ValidationError("The minimum cannot exceed the maximum.");
  }
  if (nominal !== null && ((min !== null && nominal < min) || (max !== null && nominal > max))) {
    throw new ValidationError("The nominal value must be within the acceptable range.");
  }
  return [
    metric, nominal, min, max, optionalText(input.source, "Source"),
    optionalText(input.notes, "Notes", 10_000),
  ];
}

export function validTimestamp(value: unknown): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ValidationError("Enter a valid measurement date.");
  }
  return new Date(value).toISOString();
}

export function isAssetKey(value: unknown): value is string {
  return typeof value === "string" &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.(?:jpg|png)$/.test(value);
}

function bounded(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${label} is outside the supported range.`);
  }
  return value;
}

function layerTransform(value: LayerTransform): LayerTransform {
  requireObject(value, "Layer transform");
  return {
    x: bounded(value.x, -10, 10, "Horizontal position"),
    y: bounded(value.y, -10, 10, "Vertical position"),
    rotation: bounded(value.rotation, -180, 180, "Rotation"),
    scale: bounded(value.scale, 0.1, 6, "Scale"),
  };
}

export function comparisonAlignment(input: ComparisonInput): ImageAlignment {
  requireObject(input, "Comparison");
  const state = input.alignment;
  requireObject(state, "Image alignment");
  requireObject(state.pan, "Viewport position");
  if (!["overlay", "side-by-side", "alternate"].includes(state.view) ||
      typeof state.locked !== "boolean" || typeof state.guides !== "boolean") {
    throw new ValidationError("Invalid image comparison controls.");
  }
  return {
    reference: layerTransform(state.reference),
    candidate: layerTransform(state.candidate),
    opacity: bounded(state.opacity, 0, 1, "Opacity"),
    view: state.view,
    locked: state.locked,
    guides: state.guides,
    rimRadius: bounded(state.rimRadius, 0.02, 2, "Rim guide radius"),
    guideX: state.guideX === undefined ? undefined : bounded(state.guideX, -10, 10, "Horizontal guide position"),
    guideY: state.guideY === undefined ? undefined : bounded(state.guideY, -10, 10, "Vertical guide position"),
    zoom: bounded(state.zoom, 0.25, 8, "Zoom"),
    pan: {
      x: bounded(state.pan.x, -10, 10, "Horizontal pan"),
      y: bounded(state.pan.y, -10, 10, "Vertical pan"),
    },
  };
}

export function validPeaks(input: unknown): ResonancePeak[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ValidationError("At least one resonance peak is required.");
  }

  return input.map((peak: ResonancePeak) => {
    requireObject(peak, "Resonance peak");
    if (!Number.isFinite(peak.frequencyHz) || peak.frequencyHz <= 0) {
      throw new ValidationError("Peak frequency must be a positive number.");
    }
    if (peak.kind !== undefined && peak.kind !== "long" && peak.kind !== "short") {
      throw new ValidationError("Invalid peak classification.");
    }
    if (peak.source === "manual") {
      if (peak.kind === undefined) throw new ValidationError("Choose a classification for the manual peak.");
      if (peak.magnitude !== undefined || peak.sustainMs !== undefined || peak.accumulatedPowerDb !== undefined) {
        throw new ValidationError("Manual peaks cannot include measured values.");
      }
      return { source: "manual", frequencyHz: peak.frequencyHz, kind: peak.kind };
    }
    if (peak.source !== undefined && peak.source !== "measured") {
      throw new ValidationError("Invalid peak source.");
    }
    if (!Number.isFinite(peak.magnitude)) {
      throw new ValidationError("Peak magnitude must be a finite number.");
    }
    if (peak.sustainMs !== undefined && (!Number.isFinite(peak.sustainMs) || peak.sustainMs < 0)) {
      throw new ValidationError("Peak sustain duration must be a nonnegative number.");
    }
    if (peak.accumulatedPowerDb !== undefined && !Number.isFinite(peak.accumulatedPowerDb)) {
      throw new ValidationError("Accumulated peak power must be a finite number.");
    }
    return {
      source: peak.source,
      frequencyHz: peak.frequencyHz,
      magnitude: peak.magnitude,
      kind: peak.kind,
      sustainMs: peak.sustainMs,
      accumulatedPowerDb: peak.accumulatedPowerDb,
    };
  });
}
