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
 * Score every reference against the detected peaks and return the matches
 * with score >= `minScore`, sorted by score (then by tightness of fit).
 */
export function findMatchingReferences(
  pingPeaks: readonly ResonancePeak[],
  references: readonly ReferenceRecord[],
  options?: { minScore?: number },
): ReferenceMatch[] {
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  if (pingPeaks.length === 0) return [];

  const results: ReferenceMatch[] = [];
  for (const reference of references) {
    if (reference.peaks.length === 0) continue;

    let matched = 0;
    let totalError = 0;
    for (const refPeak of reference.peaks) {
      const m = peakMatches(pingPeaks, refPeak);
      if (m.matched) {
        matched += 1;
        totalError += m.errorHz;
      }
    }

    const score = matched / reference.peaks.length;
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
