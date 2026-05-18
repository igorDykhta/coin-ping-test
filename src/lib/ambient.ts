import type { SpectrumData } from "./spectrum";
import { AMBIENT_SUBTRACT_MAX_DB, AMBIENT_SUBTRACT_MIN_DB } from "./spectrum";

export const AMBIENT_CAPTURE_MS = 5_000;

/** Fraction of measured ambient power to remove (lower = gentler subtraction). */
export const AMBIENT_SUBTRACT_POWER_SCALE = 0.55;
/** Keep at least this fraction of raw signal power so the chart is not wiped to silence. */
export const AMBIENT_SUBTRACT_SIGNAL_FLOOR = 0.5;

const MIN_LINEAR_POWER = 1e-12;

export type AmbientProfile = {
  /** Per-bin noise floor in dB (from mean linear power over the capture). */
  values: Float32Array;
  sampleRate: number;
  fftSize: number;
  frameCount: number;
  capturedAt: string;
};

export function createAmbientAccumulator(binCount: number): Float32Array {
  return new Float32Array(binCount);
}

function dbToPower(db: number): number {
  return 10 ** (db / 10);
}

function powerToDb(power: number): number {
  return 10 * Math.log10(Math.max(power, MIN_LINEAR_POWER));
}

/** Sum linear power per FFT bin for each animation frame. */
export function accumulateAmbientFrame(accumulator: Float32Array, frame: Float32Array): void {
  const len = Math.min(accumulator.length, frame.length);
  for (let i = 0; i < len; i += 1) {
    accumulator[i] += dbToPower(frame[i]);
  }
}

/** Mean power per bin → dB noise floor profile. */
export function finalizeAmbientProfile(
  accumulator: Float32Array,
  frameCount: number,
  sampleRate: number,
  fftSize: number,
): AmbientProfile {
  const values = new Float32Array(accumulator.length);
  if (frameCount > 0) {
    for (let i = 0; i < values.length; i += 1) {
      const meanPower = accumulator[i] / frameCount;
      values[i] = powerToDb(meanPower);
    }
  }
  return {
    values,
    sampleRate,
    fftSize,
    frameCount,
    capturedAt: new Date().toISOString(),
  };
}

export function isAmbientCompatible(
  profile: AmbientProfile,
  sampleRate: number,
  fftSize: number,
): boolean {
  return profile.sampleRate === sampleRate && profile.fftSize === fftSize;
}

/** Write excess-power spectrum into `out` (reused buffer — no per-frame allocation). */
export function subtractAmbientInto(
  spectrum: Float32Array<ArrayBufferLike>,
  profile: AmbientProfile,
  out: Float32Array<ArrayBufferLike>,
): void {
  const len = Math.min(spectrum.length, out.length);
  for (let i = 0; i < len; i += 1) {
    const ambientDb = i < profile.values.length ? profile.values[i] : -100;
    const signalPower = dbToPower(spectrum[i]);
    const ambientPower = dbToPower(ambientDb) * AMBIENT_SUBTRACT_POWER_SCALE;
    const signalFloor = signalPower * AMBIENT_SUBTRACT_SIGNAL_FLOOR;
    const excessPower = Math.max(signalFloor, signalPower - ambientPower);

    const excessDb = powerToDb(excessPower);
    out[i] = Math.max(AMBIENT_SUBTRACT_MIN_DB, Math.min(AMBIENT_SUBTRACT_MAX_DB, excessDb));
  }
}

export function subtractAmbientSpectrum(
  spectrum: Float32Array,
  profile: AmbientProfile,
): Float32Array {
  const corrected = new Float32Array(spectrum.length);
  subtractAmbientInto(spectrum, profile, corrected);
  return corrected;
}

export function applyAmbientToSpectrumData(
  spectrum: SpectrumData,
  profile: AmbientProfile | null,
  enabled: boolean,
  out?: Float32Array,
): SpectrumData {
  if (!profile || !enabled || !isAmbientCompatible(profile, spectrum.sampleRate, spectrum.fftSize)) {
    return spectrum;
  }

  const target =
    out && out.length === spectrum.values.length ? out : new Float32Array(spectrum.values.length);
  subtractAmbientInto(spectrum.values, profile, target);

  return {
    ...spectrum,
    values: target,
    ambientSubtracted: true,
  };
}
