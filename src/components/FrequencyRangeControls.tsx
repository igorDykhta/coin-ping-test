import { useEffect, useState } from "react";
import { Button, Input, Label } from "@sqlrooms/ui";

import {
  ABSOLUTE_MAX_DISPLAY_HZ,
  ABSOLUTE_MIN_DISPLAY_HZ,
  DEFAULT_MAX_DISPLAY_HZ,
  DEFAULT_MIN_DISPLAY_HZ,
} from "../lib/spectrum";

type FrequencyRangeControlsProps = {
  minHz: number;
  maxHz: number;
  nyquistHz: number;
  onApply: (minHz: number, maxHz: number) => void;
  onReset: () => void;
};

function formatHzInput(hz: number): string {
  return String(Math.round(hz));
}

function parseHzInput(value: string): number | null {
  const trimmed = value.trim().toLowerCase().replace(/,/g, "");
  if (!trimmed) {
    return null;
  }
  if (trimmed.endsWith("k")) {
    const n = Number.parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(n) ? n * 1000 : null;
  }
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function FrequencyRangeControls({
  minHz,
  maxHz,
  nyquistHz,
  onApply,
  onReset,
}: FrequencyRangeControlsProps) {
  const [minInput, setMinInput] = useState(() => formatHzInput(minHz));
  const [maxInput, setMaxInput] = useState(() => formatHzInput(maxHz));

  useEffect(() => {
    setMinInput(formatHzInput(minHz));
    setMaxInput(formatHzInput(maxHz));
  }, [minHz, maxHz]);

  function applyInputs() {
    const parsedMin = parseHzInput(minInput);
    const parsedMax = parseHzInput(maxInput);
    if (parsedMin === null || parsedMax === null) {
      setMinInput(formatHzInput(minHz));
      setMaxInput(formatHzInput(maxHz));
      return;
    }
    onApply(parsedMin, parsedMax);
  }

  const maxCap = Math.min(ABSOLUTE_MAX_DISPLAY_HZ, nyquistHz);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor="freq-min-hz" className="text-xs text-muted-foreground">
          Min frequency (Hz)
        </Label>
        <Input
          id="freq-min-hz"
          type="text"
          inputMode="decimal"
          className="h-8 w-28 font-mono text-sm"
          value={minInput}
          onChange={(event) => setMinInput(event.target.value)}
          onBlur={applyInputs}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              applyInputs();
            }
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="freq-max-hz" className="text-xs text-muted-foreground">
          Max frequency (Hz)
        </Label>
        <Input
          id="freq-max-hz"
          type="text"
          inputMode="decimal"
          className="h-8 w-28 font-mono text-sm"
          value={maxInput}
          onChange={(event) => setMaxInput(event.target.value)}
          onBlur={applyInputs}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              applyInputs();
            }
          }}
        />
      </div>
      <Button type="button" variant="outline" size="sm" className="h-8" onClick={applyInputs}>
        Apply
      </Button>
      <Button type="button" variant="outline" size="sm" className="h-8" onClick={onReset}>
        Reset ({DEFAULT_MIN_DISPLAY_HZ / 1000}k–{DEFAULT_MAX_DISPLAY_HZ / 1000}k)
      </Button>
      <p className="w-full text-xs text-muted-foreground">
        X axis: {Math.round(minHz)}–{Math.round(maxHz)} Hz. Changing range or Reset clears ambient.
        Mic limit ~{" "}
        {Math.round(maxCap)} Hz. Use{" "}
        <span className="font-mono">4700</span> or <span className="font-mono">4.7k</span>.
      </p>
    </div>
  );
}
