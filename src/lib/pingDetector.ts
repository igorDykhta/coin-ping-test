import type { ResonancePeak } from "../types/coinPing";
import { detectPeaks, type SpectrumData } from "./spectrum";

/**
 * Live ping detector.
 *
 * Watches band-limited energy in dB; when current energy is `thresholdDb` above
 * a slow EWMA baseline it triggers, holds a max-per-bin snapshot for
 * `captureMs`, then refuses to re-trigger for `refractoryMs`.
 */

export type PingDetectorConfig = {
  /** Band lower edge for energy calculation and peak detection. */
  minHz: number;
  /** Band upper edge for energy calculation and peak detection. */
  maxHz: number;
  /** dB jump above the running baseline that counts as a ping. */
  thresholdDb?: number;
  /** Max-hold + sustain accumulation window after trigger (ms). */
  captureMs?: number;
  /** Total no-retrigger window after trigger (ms). */
  refractoryMs?: number;
  /** EWMA time constant for the baseline (ms). */
  baselineTcMs?: number;
  /** Min band dB for any trigger consideration (silences tiny noise floor spikes). */
  minTriggerBandDb?: number;
  /** Minimum consecutive ms a bin must stay near its peak to count as sustained. */
  minSustainMs?: number;
  /**
   * A bin is considered "sustaining near its peak" when its dB stays within
   * this distance from its running max-hold value during capture.
   */
  sustainDropDb?: number;
};

export type DetectedPing = {
  id: string;
  detectedAt: string;
  spectrum: SpectrumData;
  peaks: ResonancePeak[];
  ambientSubtracted: boolean;
  triggerBandDb: number;
  baselineBandDb: number;
  /** Max consecutive sustained-near-peak duration (ms) of the top peak's bin. */
  topPeakSustainMs: number;
};

const DEFAULT_THRESHOLD_DB = 12;
const DEFAULT_CAPTURE_MS = 500;
const DEFAULT_REFRACTORY_MS = 800;
const DEFAULT_BASELINE_TC_MS = 800;
const DEFAULT_MIN_TRIGGER_BAND_DB = -85;
const DEFAULT_MIN_SUSTAIN_MS = 100;
const DEFAULT_SUSTAIN_DROP_DB = 8;

/** Sustain (ms) at which a peak is upgraded from "short" to "long". */
const LONG_PEAK_SUSTAIN_MS = 200;
/**
 * dB bonus added to a long peak's magnitude when ranking peaks. A long peak
 * beats any short peak that isn't at least this many dB louder.
 */
const LONG_PEAK_BONUS_DB = 10;
/** Cast a wide net before sustain-filtering so we don't miss long-but-quieter peaks. */
const RAW_PEAK_LIMIT = 24;
/** Maximum peaks kept on a single emitted ping. */
const FINAL_PEAK_LIMIT = 6;

/** Absolute Hz tolerance below which the fractional tolerance is ignored. */
const DUPLICATE_PING_MIN_HZ_TOLERANCE = 20;
/** Fractional Hz tolerance (0.5% of the top peak frequency). */
const DUPLICATE_PING_FRACTION = 0.005;

/**
 * Returns true when `candidate`'s top peak frequency matches the top peak of
 * any ping already in `existing` (within ±max(20 Hz, 0.5%)). Pings with no
 * peaks are never considered duplicates (they're already dropped earlier).
 */
export function isDuplicatePing(
  candidate: DetectedPing,
  existing: readonly DetectedPing[],
): boolean {
  const top = candidate.peaks[0];
  if (!top) return false;
  const tolerance = Math.max(
    DUPLICATE_PING_MIN_HZ_TOLERANCE,
    top.frequencyHz * DUPLICATE_PING_FRACTION,
  );
  for (const prior of existing) {
    const priorTop = prior.peaks[0];
    if (!priorTop) continue;
    if (Math.abs(priorTop.frequencyHz - top.frequencyHz) <= tolerance) {
      return true;
    }
  }
  return false;
}

type DetectorState = "idle" | "capturing" | "refractory";

export type PingDetector = {
  setConfig(next: Partial<PingDetectorConfig>): void;
  reset(): void;
  /** Feed a frame; returns a ping when capture completes, else null. */
  feed(
    values: Float32Array,
    sampleRate: number,
    fftSize: number,
    nowMs: number,
    ambientSubtracted: boolean,
  ): DetectedPing | null;
};

export function createPingDetector(initial: PingDetectorConfig): PingDetector {
  let config: Required<PingDetectorConfig> = {
    minHz: initial.minHz,
    maxHz: initial.maxHz,
    thresholdDb: initial.thresholdDb ?? DEFAULT_THRESHOLD_DB,
    captureMs: initial.captureMs ?? DEFAULT_CAPTURE_MS,
    refractoryMs: initial.refractoryMs ?? DEFAULT_REFRACTORY_MS,
    baselineTcMs: initial.baselineTcMs ?? DEFAULT_BASELINE_TC_MS,
    minTriggerBandDb: initial.minTriggerBandDb ?? DEFAULT_MIN_TRIGGER_BAND_DB,
    minSustainMs: initial.minSustainMs ?? DEFAULT_MIN_SUSTAIN_MS,
    sustainDropDb: initial.sustainDropDb ?? DEFAULT_SUSTAIN_DROP_DB,
  };

  let state: DetectorState = "idle";
  let baselineDb = -100;
  let baselinePrimed = false;
  let lastFrameMs = 0;
  let triggerStartMs = 0;
  let maxHold: Float32Array | null = null;
  let currentSustainMs: Float32Array | null = null;
  let maxSustainMs: Float32Array | null = null;
  let triggerSampleRate = 0;
  let triggerFftSize = 0;
  let triggerAmbientSubtracted = false;
  let triggerBandDb = 0;

  function reset() {
    state = "idle";
    baselineDb = -100;
    baselinePrimed = false;
    lastFrameMs = 0;
    triggerStartMs = 0;
    maxHold = null;
    currentSustainMs = null;
    maxSustainMs = null;
  }

  function setConfig(next: Partial<PingDetectorConfig>) {
    config = { ...config, ...next };
    // Re-prime baseline after any config change to avoid spurious triggers.
    baselinePrimed = false;
    if (state !== "capturing") {
      state = "idle";
    }
  }

  function computeBandDb(
    values: Float32Array,
    sampleRate: number,
    fftSize: number,
  ): number {
    const minBin = Math.max(1, Math.floor((config.minHz * fftSize) / sampleRate));
    const maxBin = Math.min(
      values.length - 1,
      Math.ceil((config.maxHz * fftSize) / sampleRate),
    );
    if (maxBin <= minBin) {
      return -200;
    }
    let powerSum = 0;
    let count = 0;
    for (let i = minBin; i <= maxBin; i += 1) {
      const db = values[i];
      if (!Number.isFinite(db)) continue;
      powerSum += 10 ** (db / 10);
      count += 1;
    }
    if (count === 0 || powerSum <= 0) return -200;
    return 10 * Math.log10(powerSum / count);
  }

  function emitPing(): DetectedPing | null {
    if (!maxHold || !maxSustainMs) return null;
    const held = maxHold;
    const sustain = maxSustainMs;
    maxHold = null;
    maxSustainMs = null;
    currentSustainMs = null;

    const heldSpectrum: SpectrumData = {
      values: held,
      sampleRate: triggerSampleRate,
      fftSize: triggerFftSize,
      ambientSubtracted: triggerAmbientSubtracted,
    };
    const rawPeaks = detectPeaks(heldSpectrum, {
      minHz: config.minHz,
      maxHz: config.maxHz,
      minDb: triggerAmbientSubtracted ? -30 : -55,
      maxPeaks: RAW_PEAK_LIMIT,
    });

    // Annotate every candidate with its bin's measured sustain duration and
    // classify it as "long" (≥ LONG_PEAK_SUSTAIN_MS) vs "short".
    const annotated = rawPeaks.map((peak) => {
      const bin = Math.round(
        (peak.frequencyHz * triggerFftSize) / triggerSampleRate,
      );
      const sustainMs =
        bin >= 0 && bin < sustain.length ? sustain[bin] : 0;
      const kind: "long" | "short" =
        sustainMs >= LONG_PEAK_SUSTAIN_MS ? "long" : "short";
      return { ...peak, sustainMs, kind };
    });

    // Drop fast transients (clicks, scrapes) — anything that didn't last
    // at least the configured minimum sustain.
    const sustained = annotated.filter(
      (p) => p.sustainMs >= config.minSustainMs,
    );
    if (sustained.length === 0) {
      return null;
    }

    // Rank by magnitude with a fixed dB bonus for long peaks, so a clearly
    // ringing tone wins over a slightly louder but transient peak.
    const ranked = [...sustained].sort((a, b) => {
      const scoreA = a.magnitude + (a.kind === "long" ? LONG_PEAK_BONUS_DB : 0);
      const scoreB = b.magnitude + (b.kind === "long" ? LONG_PEAK_BONUS_DB : 0);
      return scoreB - scoreA;
    });

    const finalPeaks = ranked
      .slice(0, FINAL_PEAK_LIMIT)
      .sort((a, b) => a.frequencyHz - b.frequencyHz);

    // Top peak sustain = longest sustain seen across the kept peaks.
    let topPeakSustainMs = 0;
    for (const p of finalPeaks) {
      if (p.sustainMs > topPeakSustainMs) topPeakSustainMs = p.sustainMs;
    }

    return {
      id: `ping-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      detectedAt: new Date().toISOString(),
      spectrum: heldSpectrum,
      peaks: finalPeaks,
      ambientSubtracted: triggerAmbientSubtracted,
      triggerBandDb,
      baselineBandDb: baselineDb,
      topPeakSustainMs,
    };
  }

  function feed(
    values: Float32Array,
    sampleRate: number,
    fftSize: number,
    nowMs: number,
    ambientSubtracted: boolean,
  ): DetectedPing | null {
    const dt = lastFrameMs === 0 ? 0 : Math.max(0, nowMs - lastFrameMs);
    lastFrameMs = nowMs;

    if (state === "capturing") {
      if (
        maxHold &&
        currentSustainMs &&
        maxSustainMs &&
        maxHold.length === values.length
      ) {
        const minBin = Math.max(
          1,
          Math.floor((config.minHz * triggerFftSize) / triggerSampleRate),
        );
        const maxBin = Math.min(
          values.length - 1,
          Math.ceil((config.maxHz * triggerFftSize) / triggerSampleRate),
        );
        const drop = config.sustainDropDb;
        for (let i = minBin; i <= maxBin; i += 1) {
          const v = values[i];
          if (v > maxHold[i]) {
            maxHold[i] = v;
          }
          // Sustain: bin stays within `drop` dB of its running peak.
          if (Number.isFinite(v) && v >= maxHold[i] - drop) {
            currentSustainMs[i] += dt;
            if (currentSustainMs[i] > maxSustainMs[i]) {
              maxSustainMs[i] = currentSustainMs[i];
            }
          } else {
            currentSustainMs[i] = 0;
          }
        }
      }
      if (nowMs - triggerStartMs >= config.captureMs) {
        const ping = emitPing();
        state = "refractory";
        return ping;
      }
      return null;
    }

    if (state === "refractory") {
      if (nowMs - triggerStartMs >= config.refractoryMs) {
        state = "idle";
        baselinePrimed = false;
      }
      return null;
    }

    const bandDb = computeBandDb(values, sampleRate, fftSize);

    if (!baselinePrimed) {
      baselineDb = bandDb;
      baselinePrimed = true;
      return null;
    }

    if (
      bandDb >= config.minTriggerBandDb &&
      bandDb - baselineDb >= config.thresholdDb
    ) {
      triggerStartMs = nowMs;
      triggerSampleRate = sampleRate;
      triggerFftSize = fftSize;
      triggerAmbientSubtracted = ambientSubtracted;
      triggerBandDb = bandDb;
      maxHold = new Float32Array(values.length);
      maxHold.set(values);
      currentSustainMs = new Float32Array(values.length);
      maxSustainMs = new Float32Array(values.length);
      state = "capturing";
      return null;
    }

    // Asymmetric EWMA: track quiet floor quickly, ignore upward outliers.
    const downTc = config.baselineTcMs;
    const upTc = config.baselineTcMs * 4;
    const tc = bandDb < baselineDb ? downTc : upTc;
    const alpha = tc > 0 ? Math.min(1, dt / tc) : 1;
    baselineDb += (bandDb - baselineDb) * alpha;

    return null;
  }

  return { setConfig, reset, feed };
}
