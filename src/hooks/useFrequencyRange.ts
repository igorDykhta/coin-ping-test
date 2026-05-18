import { useCallback, useEffect, useMemo, useState } from "react";

import {
  clampFrequencyRange,
  DEFAULT_MAX_DISPLAY_HZ,
  DEFAULT_MIN_DISPLAY_HZ,
  type FrequencyRange,
} from "../lib/spectrum";

const STORAGE_KEY = "coin-ping-test-freq-range";

function loadStoredRange(): FrequencyRange {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { minHz: DEFAULT_MIN_DISPLAY_HZ, maxHz: DEFAULT_MAX_DISPLAY_HZ };
    }
    const parsed = JSON.parse(raw) as FrequencyRange;
    if (
      typeof parsed.minHz === "number" &&
      typeof parsed.maxHz === "number" &&
      parsed.maxHz > parsed.minHz
    ) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return { minHz: DEFAULT_MIN_DISPLAY_HZ, maxHz: DEFAULT_MAX_DISPLAY_HZ };
}

export function useFrequencyRange(sampleRate: number | null) {
  const [range, setRangeState] = useState<FrequencyRange>(loadStoredRange);

  const resolved = useMemo(() => {
    const rate = sampleRate ?? 48_000;
    return clampFrequencyRange(range.minHz, range.maxHz, rate);
  }, [range.minHz, range.maxHz, sampleRate]);

  useEffect(() => {
    if (sampleRate === null) {
      return;
    }
    const reclamped = clampFrequencyRange(range.minHz, range.maxHz, sampleRate);
    if (reclamped.minHz !== range.minHz || reclamped.maxHz !== range.maxHz) {
      setRangeState(reclamped);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reclamped));
    }
  }, [sampleRate, range.minHz, range.maxHz]);

  const setRange = useCallback((minHz: number, maxHz: number) => {
    const rate = sampleRate ?? 48_000;
    const next = clampFrequencyRange(minHz, maxHz, rate);
    setRangeState(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, [sampleRate]);

  const resetRange = useCallback(() => {
    const rate = sampleRate ?? 48_000;
    const next = clampFrequencyRange(
      DEFAULT_MIN_DISPLAY_HZ,
      DEFAULT_MAX_DISPLAY_HZ,
      rate,
    );
    setRangeState(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, [sampleRate]);

  return {
    minHz: resolved.minHz,
    maxHz: resolved.maxHz,
    setRange,
    resetRange,
  };
}
