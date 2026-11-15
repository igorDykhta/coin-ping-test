import { useCallback, useState } from "react";

import {
  clampFrequencyRange,
  ABSOLUTE_MAX_DISPLAY_HZ,
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

export function useFrequencyRange() {
  const [range, setRangeState] = useState<FrequencyRange>(loadStoredRange);

  const setRange = useCallback((minHz: number, maxHz: number) => {
    // Keep the preferred bounds when the microphone and a retained recording
    // have different frequency limits. Each spectrum clamps its own view.
    const next = clampFrequencyRange(minHz, maxHz, 2 * ABSOLUTE_MAX_DISPLAY_HZ);
    setRangeState(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const resetRange = useCallback(() => {
    setRange(DEFAULT_MIN_DISPLAY_HZ, DEFAULT_MAX_DISPLAY_HZ);
  }, [setRange]);

  return {
    ...range,
    setRange,
    resetRange,
  };
}
