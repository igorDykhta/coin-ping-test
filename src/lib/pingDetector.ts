import type { ResonancePeak } from "../types/coinPing";
import { detectPeaks, type SpectrumData } from "./spectrum";

/**
 * Live ping detector.
 *
 * Watches band-limited energy in dB; when current energy is `thresholdDb` above
 * a slow EWMA baseline it triggers, holds a max-per-bin snapshot for
 * `captureMs`, integrates per-bin power after an initial delay, then refuses
 * to re-trigger for `refractoryMs`. Peak ranking favors frequencies with high
 * accumulated post-transient power so sustained resonances beat brief spikes.
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
  /**
   * After trigger, skip this many ms before integrating per-bin power. The
   * initial transient is loud across many bins; delaying accumulation focuses
   * on energy that keeps ringing and improves long-peak detection.
   */
  powerAccumDelayMs?: number;
};

export type DetectedPing = {
  id: string;
  detectedAt: string;
  /** Max-hold spectrum captured during the ping window. */
  spectrum: SpectrumData;
  /**
   * Time-averaged power over the full capture window: ∫(standing power)·dt / T.
   * Bins without standing resonance average to zero; ringing bins stay elevated.
   */
  accumulatedSpectrum?: SpectrumData | null;
  peaks: ResonancePeak[];
  ambientSubtracted: boolean;
  triggerBandDb?: number;
  baselineBandDb?: number;
  /** Max consecutive sustained-near-peak duration (ms) of the top peak's bin. */
  topPeakSustainMs?: number;
};

const DEFAULT_THRESHOLD_DB = 12;
/** Max-hold + power-integration window after trigger (ms). */
const DEFAULT_CAPTURE_MS = 5000;
/** Total no-retrigger window after trigger (ms). Must exceed captureMs. */
const DEFAULT_REFRACTORY_MS = 5000;
const DEFAULT_BASELINE_TC_MS = 800;
const DEFAULT_MIN_TRIGGER_BAND_DB = -85;
const DEFAULT_MIN_SUSTAIN_MS = 100;
const DEFAULT_SUSTAIN_DROP_DB = 8;
/** Ignore the first N ms of capture when integrating per-bin power. */
const DEFAULT_POWER_ACCUM_DELAY_MS = 60;
/** Red integration starts after this much continuous sustain (ms). */
const ACCUM_START_SUSTAIN_MS = 250;
/** Only the live preview decays when energy falls away (dB/s). */
const PREVIEW_DECAY_DB_PER_SEC = 20;
const MIN_LINEAR_POWER = 1e-12;

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

/** Fractional Hz tolerance when merging peak lists. */
const PEAK_MERGE_FRACTION = 0.005;
const PEAK_MERGE_MIN_HZ = 20;

function linearPowerFromDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return 10 ** (db / 10);
}

function dbFromLinearPower(power: number): number {
  return 10 * Math.log10(Math.max(power, MIN_LINEAR_POWER));
}

function peaksWithinTolerance(
  frequencyHz: number,
  others: readonly ResonancePeak[],
): boolean {
  const tolerance = Math.max(
    PEAK_MERGE_MIN_HZ,
    frequencyHz * PEAK_MERGE_FRACTION,
  );
  return others.some(
    (peak) => Math.abs(peak.frequencyHz - frequencyHz) <= tolerance,
  );
}

export type PingCaptureOverlays = {
  spectrum: SpectrumData;
  accumulated: SpectrumData | null;
};

function cloneSpectrumData(spectrum: SpectrumData): SpectrumData {
  return {
    values: new Float32Array(spectrum.values),
    sampleRate: spectrum.sampleRate,
    fftSize: spectrum.fftSize,
    ambientSubtracted: spectrum.ambientSubtracted,
  };
}

function buildAccumulatedSpectrum(
  delayedAccum: Float32Array,
  windowMs: number,
  sampleRate: number,
  fftSize: number,
  ambientSubtracted: boolean,
): SpectrumData {
  const accumValues = new Float32Array(delayedAccum.length);
  const w = Math.max(1, windowMs);
  for (let i = 0; i < delayedAccum.length; i += 1) {
    // Same elapsed time T for every bin: no standing power → ∫0/T → chart floor.
    accumValues[i] = dbFromLinearPower(delayedAccum[i] / w);
  }
  return {
    values: accumValues,
    sampleRate,
    fftSize,
    ambientSubtracted,
  };
}
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

export type PingCaptureProgress = {
  /** Fraction of the capture window still remaining (1 → 0). */
  remaining: number;
  elapsedMs: number;
  totalMs: number;
  /** `performance.now()` when the capture window opened. */
  startedAtMs: number;
};

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
  /**
   * While capturing, returns the in-progress post-transient power spectrum for
   * live chart overlay. Null when idle or refractory.
   */
  getAccumulatedPreview(): SpectrumData | null;
  /**
   * While capturing, returns the in-progress max-hold spectrum for live overlay.
   */
  getMaxHoldPreview(): SpectrumData | null;
  /**
   * Spectra from the most recent capture window (even if no ping was emitted).
   */
  getLastCaptureOverlays(): PingCaptureOverlays | null;
  /** Progress while a ping capture window is open; null when idle/refractory. */
  getCaptureProgress(nowMs: number): PingCaptureProgress | null;
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
    powerAccumDelayMs: initial.powerAccumDelayMs ?? DEFAULT_POWER_ACCUM_DELAY_MS,
  };

  let state: DetectorState = "idle";
  let baselineDb = -100;
  let baselinePrimed = false;
  let lastFrameMs = 0;
  let triggerStartMs = 0;
  let maxHold: Float32Array | null = null;
  let previewHold: Float32Array | null = null;
  let currentSustainMs: Float32Array | null = null;
  let maxSustainMs: Float32Array | null = null;
  /** Per-bin ∫ linear power·dt (only while standing resonance). */
  let delayedPowerAccum: Float32Array | null = null;
  /** Elapsed ms in the post-delay window (shared denominator for all bins). */
  let delayedAccumWindowMs = 0;
  let triggerSampleRate = 0;
  let triggerFftSize = 0;
  let triggerAmbientSubtracted = false;
  let triggerBandDb = 0;
  let lastCaptureOverlays: PingCaptureOverlays | null = null;

  function reset() {
    state = "idle";
    baselineDb = -100;
    baselinePrimed = false;
    lastFrameMs = 0;
    triggerStartMs = 0;
    maxHold = null;
    previewHold = null;
    currentSustainMs = null;
    maxSustainMs = null;
    delayedPowerAccum = null;
    delayedAccumWindowMs = 0;
    lastCaptureOverlays = null;
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

  function ensureCaptureBuffers(values: Float32Array) {
    const len = values.length;
    if (maxHold && maxHold.length === len) {
      return;
    }

    const prevHold = maxHold;
    const prevPreview = previewHold;
    const prevCur = currentSustainMs;
    const prevMax = maxSustainMs;
    const prevAccum = delayedPowerAccum;
    const prevWindowMs = delayedAccumWindowMs;

    maxHold = new Float32Array(len);
    maxHold.set(values);
    previewHold = new Float32Array(values);
    if (prevHold) {
      const copyLen = Math.min(prevHold.length, len);
      for (let i = 0; i < copyLen; i += 1) {
        maxHold[i] = Math.max(maxHold[i], prevHold[i]);
        previewHold[i] = Math.max(previewHold[i], prevPreview?.[i] ?? prevHold[i]);
      }
    }

    currentSustainMs = new Float32Array(len);
    maxSustainMs = new Float32Array(len);
    delayedPowerAccum = new Float32Array(len);
    delayedAccumWindowMs = prevWindowMs;
    if (prevCur && prevMax && prevAccum) {
      const copyLen = Math.min(prevCur.length, len);
      currentSustainMs.set(prevCur.subarray(0, copyLen));
      maxSustainMs.set(prevMax.subarray(0, copyLen));
      delayedPowerAccum.set(prevAccum.subarray(0, copyLen));
    }
  }

  function getAccumulatedPreview(): SpectrumData | null {
    if (
      state !== "capturing" ||
      !delayedPowerAccum ||
      delayedAccumWindowMs < 1
    ) {
      return null;
    }
    return buildAccumulatedSpectrum(
      delayedPowerAccum,
      delayedAccumWindowMs,
      triggerSampleRate,
      triggerFftSize,
      triggerAmbientSubtracted,
    );
  }

  function getMaxHoldPreview(): SpectrumData | null {
    if (state !== "capturing" || !previewHold) {
      return null;
    }
    return {
      values: new Float32Array(previewHold),
      sampleRate: triggerSampleRate,
      fftSize: triggerFftSize,
      ambientSubtracted: triggerAmbientSubtracted,
    };
  }

  function getLastCaptureOverlays(): PingCaptureOverlays | null {
    return lastCaptureOverlays;
  }

  function getCaptureProgress(nowMs: number): PingCaptureProgress | null {
    if (state !== "capturing") {
      return null;
    }
    const totalMs = config.captureMs;
    const elapsedMs = Math.max(0, Math.min(totalMs, nowMs - triggerStartMs));
    const remaining = Math.max(0, 1 - elapsedMs / totalMs);
    return { remaining, elapsedMs, totalMs, startedAtMs: triggerStartMs };
  }

  function emitPing(): DetectedPing | null {
    if (!maxHold || !maxSustainMs) return null;
    const held = maxHold;
    const sustain = maxSustainMs;
    const delayedAccum = delayedPowerAccum;
    const accumWindowMs = Math.max(1, delayedAccumWindowMs);
    maxHold = null;
    previewHold = null;
    maxSustainMs = null;
    currentSustainMs = null;
    delayedPowerAccum = null;
    delayedAccumWindowMs = 0;

    const heldSpectrum: SpectrumData = {
      values: held,
      sampleRate: triggerSampleRate,
      fftSize: triggerFftSize,
      ambientSubtracted: triggerAmbientSubtracted,
    };
    const minDb = triggerAmbientSubtracted ? -30 : -55;
    const peakOptions = {
      minHz: config.minHz,
      maxHz: config.maxHz,
      minDb,
      maxPeaks: RAW_PEAK_LIMIT,
    };

    const holdPeaks = detectPeaks(heldSpectrum, peakOptions);

    // Build a spectrum from time-averaged power after the initial transient.
    // Sustained resonances keep integrating energy; brief spikes do not.
    let accumulatedSpectrum: SpectrumData | null = null;
    let rawPeaks = holdPeaks;
    if (delayedAccum && accumWindowMs >= 1) {
      accumulatedSpectrum = buildAccumulatedSpectrum(
        delayedAccum,
        accumWindowMs,
        triggerSampleRate,
        triggerFftSize,
        triggerAmbientSubtracted,
      );
      const accumPeaks = detectPeaks(accumulatedSpectrum, peakOptions);
      rawPeaks = [...accumPeaks];
      for (const holdPeak of holdPeaks) {
        if (!peaksWithinTolerance(holdPeak.frequencyHz, rawPeaks)) {
          rawPeaks.push(holdPeak);
        }
      }
    }

    lastCaptureOverlays = {
      spectrum: cloneSpectrumData(heldSpectrum),
      accumulated: accumulatedSpectrum
        ? cloneSpectrumData(accumulatedSpectrum)
        : null,
    };

    const binForHz = (frequencyHz: number) =>
      Math.round((frequencyHz * triggerFftSize) / triggerSampleRate);

    const accumulatedDbForBin = (bin: number): number | undefined => {
      if (!delayedAccum || bin < 0 || bin >= delayedAccum.length || delayedAccum[bin] <= 0) {
        return undefined;
      }
      return dbFromLinearPower(delayedAccum[bin] / accumWindowMs);
    };

    // Annotate every candidate with sustain, kind, max-hold magnitude, and
    // delayed power average used for ranking long resonances.
    const annotated = rawPeaks.map((peak) => {
      const bin = binForHz(peak.frequencyHz);
      const sustainMs = bin >= 0 && bin < sustain.length ? sustain[bin] : 0;
      const kind: "long" | "short" =
        sustainMs >= LONG_PEAK_SUSTAIN_MS ? "long" : "short";
      const magnitude =
        bin >= 0 && bin < held.length && Number.isFinite(held[bin])
          ? held[bin]
          : peak.magnitude;
      const accumulatedPowerDb = accumulatedDbForBin(bin);
      return { ...peak, magnitude, sustainMs, kind, accumulatedPowerDb };
    });

    // Drop fast transients (clicks, scrapes) — anything that didn't last
    // at least the configured minimum sustain.
    const sustained = annotated.filter(
      (p) => p.sustainMs >= config.minSustainMs,
    );
    if (sustained.length === 0) {
      return null;
    }

    // Rank by delayed accumulated power when available, with a fixed dB bonus
    // for long peaks so clearly ringing tones beat transient spikes.
    const peakScore = (p: (typeof sustained)[number]) => {
      const base = p.accumulatedPowerDb ?? p.magnitude;
      return base + (p.kind === "long" ? LONG_PEAK_BONUS_DB : 0);
    };
    const ranked = [...sustained].sort((a, b) => peakScore(b) - peakScore(a));

    const finalPeaks = ranked
      .slice(0, FINAL_PEAK_LIMIT)
      .sort((a, b) => a.frequencyHz - b.frequencyHz);

    // Top peak sustain = longest sustain seen across the kept peaks.
    let topPeakSustainMs = 0;
    for (const p of finalPeaks) {
      if ((p.sustainMs ?? 0) > topPeakSustainMs) topPeakSustainMs = p.sustainMs ?? 0;
    }

    return {
      id: `ping-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      detectedAt: new Date().toISOString(),
      spectrum: heldSpectrum,
      accumulatedSpectrum,
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
      ensureCaptureBuffers(values);
      if (maxHold && previewHold && currentSustainMs && maxSustainMs && delayedPowerAccum) {
        const minBin = Math.max(
          1,
          Math.floor((config.minHz * triggerFftSize) / triggerSampleRate),
        );
        const maxBin = Math.min(
          values.length - 1,
          Math.ceil((config.maxHz * triggerFftSize) / triggerSampleRate),
        );
        const drop = config.sustainDropDb;
        const inDelayedPhase =
          nowMs - triggerStartMs >= config.powerAccumDelayMs;
        const minAccumDb = triggerAmbientSubtracted ? -28 : -48;

        if (dt > 0 && inDelayedPhase) {
          delayedAccumWindowMs += dt;
        }

        for (let i = minBin; i <= maxBin; i += 1) {
          const v = values[i];
          if (Number.isFinite(v) && v > maxHold[i]) {
            maxHold[i] = v;
          }
          // Keep capture maxima for peak extraction and sustain measurement.
          // Decaying those maxima would erase short tones and count quiet tails.
          if (Number.isFinite(v) && v > previewHold[i]) {
            previewHold[i] = v;
          } else if (
            dt > 0 &&
            Number.isFinite(v) &&
            v < previewHold[i] - drop
          ) {
            previewHold[i] -= PREVIEW_DECAY_DB_PER_SEC * (dt / 1000);
            if (v > previewHold[i]) {
              previewHold[i] = v;
            }
          }

          const sustaining =
            Number.isFinite(v) && v >= maxHold[i] - drop;
          if (sustaining) {
            currentSustainMs[i] += dt;
            if (currentSustainMs[i] > maxSustainMs[i]) {
              maxSustainMs[i] = currentSustainMs[i];
            }
          } else {
            currentSustainMs[i] = 0;
          }

          // Measure sustain against the captured per-bin maximum, independently
          // of the decaying preview and the loudest peak elsewhere in the band.
          const standing =
            sustaining &&
            v >= minAccumDb &&
            currentSustainMs[i] >= ACCUM_START_SUSTAIN_MS;
          if (dt > 0 && inDelayedPhase && standing) {
            const linear = linearPowerFromDb(v);
            if (linear > 0) {
              delayedPowerAccum[i] += linear * dt;
            }
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
      previewHold = new Float32Array(values);
      currentSustainMs = new Float32Array(values.length);
      maxSustainMs = new Float32Array(values.length);
      delayedPowerAccum = new Float32Array(values.length);
      delayedAccumWindowMs = 0;
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

  return {
    setConfig,
    reset,
    feed,
    getAccumulatedPreview,
    getMaxHoldPreview,
    getLastCaptureOverlays,
    getCaptureProgress,
  };
}
