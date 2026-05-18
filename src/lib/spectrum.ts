import type { ResonancePeak } from "../types/coinPing";

/** Larger FFT → finer frequency bins (~6 Hz at 48 kHz). */
export const FFT_SIZE = 8192;
/** Frequency range shown on the chart (capped by Nyquist at runtime). */
export const MIN_DISPLAY_HZ = 500;
export const MAX_DISPLAY_HZ = 30_000;

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
export const LIVE_ANALYZER_MIN_DB = -90;
export const LIVE_ANALYZER_MAX_DB = 0;

/** Recording / default scale. */
export const ANALYZER_MIN_DB = -70;
export const ANALYZER_MAX_DB = 0;

export type SpectrumData = {
  values: Float32Array;
  sampleRate: number;
  fftSize: number;
};

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
export function sampleSpectrumAtBin(values: Float32Array, bin: number): number {
  const lower = Math.floor(bin);
  const upper = Math.min(values.length - 1, lower + 1);
  const t = bin - lower;
  return values[lower] * (1 - t) + values[upper] * t;
}

/** Sample spectrum on a log-spaced frequency grid (more pixels for low Hz). */
export function sampleLogFrequencySpectrum(
  values: Float32Array,
  sampleRate: number,
  fftSize: number,
  pointCount: number,
  minHz = MIN_DISPLAY_HZ,
  maxHz = MAX_DISPLAY_HZ,
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
      samples[i] = sampleSpectrumAtBin(values, bin);
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
  options: { maxPeaks?: number; minDb?: number; minBinSeparation?: number } = {},
): ResonancePeak[] {
  const { maxPeaks = 8, minDb = -70, minBinSeparation = 3 } = options;
  const { values, sampleRate, fftSize } = spectrum;
  const lastBin = maxDisplayBin(sampleRate, fftSize);
  const minBin = Math.max(1, frequencyToBin(MIN_DISPLAY_HZ, sampleRate, fftSize));
  const candidates: ResonancePeak[] = [];

  for (let i = minBin; i < lastBin; i += 1) {
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
