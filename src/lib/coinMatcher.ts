import type { ReferenceRecord, ResonancePeak } from "../types/coinPing";

/**
 * Peak-frequency match tolerance. A detected peak is considered the "same"
 * resonance as a reference peak when their Hz differ by no more than
 * max(`MATCH_MIN_HZ_TOLERANCE`, frequency * `MATCH_FRACTION`).
 *
 * 1.5 % covers typical strike-to-strike variation plus FFT interpolation
 * jitter without conflating distinct resonances (which usually differ by
 * 5–20%).
 */
const MATCH_MIN_HZ_TOLERANCE = 20;
const MATCH_FRACTION = 0.015;

/** Minimum reference-peak coverage to call a reference a "match". */
const DEFAULT_MIN_SCORE = 0.6;

export type ReferenceMatch = {
  reference: ReferenceRecord;
  /** How many of `reference.peaks` were found in the candidate peaks. */
  matchedRefPeakCount: number;
  /** matchedRefPeakCount / reference.peaks.length, 0..1. */
  score: number;
  /** Average Hz error across matched peaks (lower is tighter). */
  avgErrorHz: number;
};

function peakMatches(
  pingPeaks: readonly ResonancePeak[],
  refPeak: ResonancePeak,
): { matched: boolean; errorHz: number } {
  const tol = Math.max(
    MATCH_MIN_HZ_TOLERANCE,
    refPeak.frequencyHz * MATCH_FRACTION,
  );
  let bestError = Infinity;
  for (const pp of pingPeaks) {
    const err = Math.abs(pp.frequencyHz - refPeak.frequencyHz);
    if (err <= tol && err < bestError) {
      bestError = err;
    }
  }
  return { matched: bestError !== Infinity, errorHz: bestError };
}

/**
 * If any peaks are annotated as "long", return only those — they're far more
 * reliable than transient "short" peaks. Falls back to all peaks when nothing
 * is annotated (e.g. references saved before peak kind tracking existed).
 */
function preferLongPeaks(
  peaks: readonly ResonancePeak[],
): readonly ResonancePeak[] {
  const longs = peaks.filter((p) => p.kind === "long");
  return longs.length > 0 ? longs : peaks;
}

/**
 * Score every reference against the detected peaks and return the matches
 * with score >= `minScore`, sorted by score (then by tightness of fit).
 *
 * Long peaks are preferred on both sides of the comparison; short peaks are
 * ignored when long peaks are available, since short peaks are often
 * mechanical transients that don't faithfully represent the coin's resonance.
 */
export function findMatchingReferences(
  pingPeaks: readonly ResonancePeak[],
  references: readonly ReferenceRecord[],
  options?: { minScore?: number },
): ReferenceMatch[] {
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  if (pingPeaks.length === 0) return [];

  const candidatePeaks = preferLongPeaks(pingPeaks);

  const results: ReferenceMatch[] = [];
  for (const reference of references) {
    const referencePeaks = preferLongPeaks(reference.peaks);
    if (referencePeaks.length === 0) continue;

    let matched = 0;
    let totalError = 0;
    for (const refPeak of referencePeaks) {
      const m = peakMatches(candidatePeaks, refPeak);
      if (m.matched) {
        matched += 1;
        totalError += m.errorHz;
      }
    }

    const score = matched / referencePeaks.length;
    if (score < minScore) continue;

    results.push({
      reference,
      matchedRefPeakCount: matched,
      score,
      avgErrorHz: matched === 0 ? Infinity : totalError / matched,
    });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.avgErrorHz - b.avgErrorHz;
  });
  return results;
}
