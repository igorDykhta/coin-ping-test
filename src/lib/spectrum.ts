import type { ResonancePeak } from "../types/coinPing";

/** Default live FFT (~6 Hz/bin at 48 kHz). */
export const FFT_SIZE = 8192;
/** Highest FFT size we'll switch to when zoomed (~1.5 Hz/bin at 48 kHz). */
export const FFT_SIZE_MAX = 32_768;
/** Above this visible span (Hz), keep FFT_SIZE for snappy response. */
export const ZOOM_FFT_SPAN_THRESHOLD_HZ = 4_000;
/** Target FFT bins inside the visible band when scaling FFT for zoom. */
export const ZOOM_FFT_TARGET_BINS_IN_VIEW = 128;

/** Round to a valid power-of-two AnalyserNode.fftSize in [32, 32768]. */
function roundToValidAnalyserFftSize(size: number): number {
  const exp = Math.min(15, Math.max(5, Math.round(Math.log2(size))));
  return 2 ** exp;
}

/**
 * Pick analyser FFT size from the visible Hz span. Wide views stay at FFT_SIZE
 * for responsiveness; narrow zooms scale up to FFT_SIZE_MAX for more bins.
 */
export function resolveFftSizeForSpan(spanHz: number, sampleRate: number): number {
  if (!Number.isFinite(spanHz) || spanHz <= 0 || !Number.isFinite(sampleRate)) {
    return FFT_SIZE;
  }
  if (spanHz >= ZOOM_FFT_SPAN_THRESHOLD_HZ) {
    return FFT_SIZE;
  }
  const targetBinHz = spanHz / ZOOM_FFT_TARGET_BINS_IN_VIEW;
  const rounded = roundToValidAnalyserFftSize(sampleRate / targetBinHz);
  return Math.max(FFT_SIZE, Math.min(FFT_SIZE_MAX, rounded));
}
/**
 * Lower edge of the ping detection band. Keyboard, mouse, and touchpad clicks
 * dump most of their energy below ~3-4 kHz; coin resonances sit well above.
 */
export const PING_DETECTION_MIN_HZ = 4_000;

/** Frequency range shown on the chart (capped by Nyquist at runtime). */
export const DEFAULT_MIN_DISPLAY_HZ = 500;
export const DEFAULT_MAX_DISPLAY_HZ = 30_000;
export const ABSOLUTE_MIN_DISPLAY_HZ = 50;
export const ABSOLUTE_MAX_DISPLAY_HZ = 30_000;
export const MIN_FREQ_SPAN_HZ = 100;

/** @deprecated Use DEFAULT_* */
export const MIN_DISPLAY_HZ = DEFAULT_MIN_DISPLAY_HZ;
/** @deprecated Use DEFAULT_* */
export const MAX_DISPLAY_HZ = DEFAULT_MAX_DISPLAY_HZ;

/** Bar density on the chart (pixels per bar slot). */
export const CHART_BAR_SLOT_PX = 2;
export const CHART_MAX_BARS = 512;
export const CHART_MIN_BARS = 160;

/** Standard frequency grid lines (Hz). */
export const FREQUENCY_GRID_HZ = [
  500, 1000, 2000, 5000, 10_000, 15_000, 20_000, 25_000, 30_000,
];
/** Mic pre-gain (~25 dB). Raise if bars stay short; lower if they peg at 0 dB. */
export const LIVE_INPUT_GAIN = 14;

/** Extra lift on the chart so quiet input uses more of the vertical range. */
export const LIVE_DISPLAY_BOOST_DB = 18;

/** Live view: narrower dB window → taller bars for the same signal. */
export const LIVE_ANALYZER_MIN_DB = -100;
export const LIVE_ANALYZER_MAX_DB = 0;

/** Recording / default scale. */
export const ANALYZER_MIN_DB = -70;
export const ANALYZER_MAX_DB = 0;

export type SpectrumData = {
  values: Float32Array;
  sampleRate: number;
  fftSize: number;
  ambientSubtracted?: boolean;
};

export type FrequencyRange = {
  minHz: number;
  maxHz: number;
};

export function nyquistHz(sampleRate: number): number {
  return sampleRate / 2;
}

export function clampFrequencyRange(
  minHz: number,
  maxHz: number,
  sampleRate: number,
): FrequencyRange {
  const nyquist = nyquistHz(sampleRate);
  const maxCap = Math.min(ABSOLUTE_MAX_DISPLAY_HZ, nyquist);
  let min = Math.max(ABSOLUTE_MIN_DISPLAY_HZ, minHz);
  let max = Math.min(maxCap, maxHz);
  if (max - min < MIN_FREQ_SPAN_HZ) {
    max = Math.min(maxCap, min + MIN_FREQ_SPAN_HZ);
  }
  if (max - min < MIN_FREQ_SPAN_HZ) {
    min = Math.max(ABSOLUTE_MIN_DISPLAY_HZ, max - MIN_FREQ_SPAN_HZ);
  }
  return { minHz: min, maxHz: max };
}

/** Nice tick marks for the current view range. */
export function buildFrequencyGrid(minHz: number, maxHz: number): number[] {
  const span = maxHz - minHz;
  if (span <= 0) {
    return [Math.round(minHz)];
  }

  const targetTicks = 8;
  const rawStep = span / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  let step = magnitude;
  if (normalized < 1.5) {
    step = magnitude;
  } else if (normalized < 3.5) {
    step = 2 * magnitude;
  } else if (normalized < 7.5) {
    step = 5 * magnitude;
  } else {
    step = 10 * magnitude;
  }

  const ticks: number[] = [];
  const start = Math.ceil(minHz / step) * step;
  for (let hz = start; hz <= maxHz + step * 0.001; hz += step) {
    ticks.push(Math.round(hz));
  }

  const roundedMin = Math.round(minHz);
  const roundedMax = Math.round(maxHz);
  if (ticks.length === 0 || ticks[0] > roundedMin + step * 0.05) {
    ticks.unshift(roundedMin);
  }
  if (ticks[ticks.length - 1] < roundedMax - step * 0.05) {
    ticks.push(roundedMax);
  }

  return [...new Set(ticks)].sort((a, b) => a - b);
}

/** Y axis after ambient subtraction. */
export const AMBIENT_SUBTRACT_MIN_DB = -100;
export const AMBIENT_SUBTRACT_MAX_DB = 40;

export function binToFrequencyHz(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize;
}

export function frequencyToBin(frequencyHz: number, sampleRate: number, fftSize: number): number {
  return Math.round((frequencyHz * fftSize) / sampleRate);
}

export function maxDisplayBin(sampleRate: number, fftSize: number): number {
  const nyquistHz = sampleRate / 2;
  const displayMaxHz = Math.min(MAX_DISPLAY_HZ, nyquistHz);
  return Math.min(
    Math.floor((displayMaxHz * fftSize) / sampleRate),
    fftSize / 2 - 1,
  );
}

export function maxDisplayHz(sampleRate: number, fftSize: number): number {
  return binToFrequencyHz(maxDisplayBin(sampleRate, fftSize), sampleRate, fftSize);
}

/** Interpolate dB at a fractional bin index. */
export function sampleSpectrumAtBin(
  values: Float32Array,
  bin: number,
  preserveGaps = false,
): number {
  const lower = Math.floor(bin);
  const upper = Math.min(values.length - 1, lower + 1);
  const vl = values[lower];
  const vu = values[upper];
  if (preserveGaps) {
    const fl = Number.isFinite(vl);
    const fu = Number.isFinite(vu);
    if (!fl && !fu) {
      return Number.NaN;
    }
    if (!fl) {
      return vu;
    }
    if (!fu) {
      return vl;
    }
  }
  const t = bin - lower;
  return vl * (1 - t) + vu * t;
}

/** Sample spectrum on a log-spaced frequency grid (more pixels for low Hz). */
export function sampleLogFrequencySpectrum(
  values: Float32Array,
  sampleRate: number,
  fftSize: number,
  pointCount: number,
  minHz = MIN_DISPLAY_HZ,
  maxHz = MAX_DISPLAY_HZ,
  preserveGaps = false,
): Float32Array {
  const lastBin = maxDisplayBin(sampleRate, fftSize);
  const effectiveMaxHz = Math.min(maxHz, binToFrequencyHz(lastBin, sampleRate, fftSize));
  const samples = new Float32Array(pointCount);
  const logMin = Math.log10(minHz);
  const logMax = Math.log10(effectiveMaxHz);

  for (let i = 0; i < pointCount; i += 1) {
    const t = pointCount <= 1 ? 0 : i / (pointCount - 1);
    const hz = 10 ** (logMin + t * (logMax - logMin));
    const bin = (hz * fftSize) / sampleRate;
    if (bin >= lastBin) {
      samples[i] = values[lastBin];
    } else {
      samples[i] = sampleSpectrumAtBin(values, bin, preserveGaps);
    }
  }

  return samples;
}

export type DisplayRange = {
  minDb: number;
  maxDb: number;
};

/** Zoom Y axis to the current signal (skip DC bin 0). */
export function computeSensitiveDisplayRange(
  values: Float32Array,
  lastBin: number,
  options: { spanDb?: number; headroomDb?: number; floorDb?: number } = {},
): DisplayRange {
  const { spanDb = 42, headroomDb = 4, floorDb = -110 } = options;
  let peak = floorDb;

  for (let i = 1; i <= lastBin; i += 1) {
    if (values[i] > peak) {
      peak = values[i];
    }
  }

  const maxDb = peak + headroomDb;
  const minDb = Math.max(floorDb, maxDb - spanDb);
  return { minDb, maxDb };
}

export function smoothDisplayRange(
  previous: DisplayRange | null,
  next: DisplayRange,
  attack = 0.55,
  release = 0.12,
): DisplayRange {
  if (!previous) {
    return next;
  }

  const rising = next.maxDb > previous.maxDb;
  const maxBlend = rising ? attack : release;
  const minBlend = rising ? attack : release;

  return {
    maxDb: previous.maxDb + (next.maxDb - previous.maxDb) * maxBlend,
    minDb: previous.minDb + (next.minDb - previous.minDb) * minBlend,
  };
}

/** Max-hold spectrum while playing a buffer through an AnalyserNode. */
export async function computeSpectrumFromBuffer(
  audioBuffer: AudioBuffer,
  fftSize = FFT_SIZE,
): Promise<SpectrumData> {
  const ctx = new AudioContext();
  try {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -100;
    analyser.maxDecibels = 0;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);

    const held = new Float32Array(analyser.frequencyBinCount).fill(-100);
    const snapshot = new Float32Array(analyser.frequencyBinCount);

    source.start(0);
    const durationMs = audioBuffer.duration * 1000 + 50;
    const start = performance.now();

    await new Promise<void>((resolve) => {
      const sample = () => {
        analyser.getFloatFrequencyData(snapshot);
        for (let i = 0; i < held.length; i += 1) {
          if (snapshot[i] > held[i]) {
            held[i] = snapshot[i];
          }
        }
        if (performance.now() - start < durationMs) {
          requestAnimationFrame(sample);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(sample);
    });

    return {
      values: held,
      sampleRate: audioBuffer.sampleRate,
      fftSize,
    };
  } finally {
    await ctx.close();
  }
}

export function detectPeaks(
  spectrum: SpectrumData,
  options: {
    maxPeaks?: number;
    minDb?: number;
    minBinSeparation?: number;
    minHz?: number;
    maxHz?: number;
  } = {},
): ResonancePeak[] {
  const {
    maxPeaks = 8,
    minDb = -70,
    minBinSeparation = 3,
    minHz = DEFAULT_MIN_DISPLAY_HZ,
    maxHz = DEFAULT_MAX_DISPLAY_HZ,
  } = options;
  const { values, sampleRate, fftSize } = spectrum;
  const { minHz: viewMin, maxHz: viewMax } = clampFrequencyRange(minHz, maxHz, sampleRate);
  const lastBin = maxDisplayBin(sampleRate, fftSize);
  const minBin = Math.max(1, frequencyToBin(viewMin, sampleRate, fftSize));
  const maxBin = Math.min(lastBin, frequencyToBin(viewMax, sampleRate, fftSize));
  const candidates: ResonancePeak[] = [];

  for (let i = minBin; i <= maxBin; i += 1) {
    const magnitude = values[i];
    if (magnitude < minDb) {
      continue;
    }
    if (magnitude <= values[i - 1] || magnitude <= values[i + 1]) {
      continue;
    }
    candidates.push({
      frequencyHz: binToFrequencyHz(i, sampleRate, fftSize),
      magnitude,
    });
  }

  candidates.sort((a, b) => b.magnitude - a.magnitude);

  const peaks: ResonancePeak[] = [];
  for (const candidate of candidates) {
    const tooClose = peaks.some(
      (peak) =>
        Math.abs(peak.frequencyHz - candidate.frequencyHz) <
        binToFrequencyHz(minBinSeparation, sampleRate, fftSize),
    );
    if (!tooClose) {
      peaks.push(candidate);
    }
    if (peaks.length >= maxPeaks) {
      break;
    }
  }

  return peaks.sort((a, b) => a.frequencyHz - b.frequencyHz);
}
