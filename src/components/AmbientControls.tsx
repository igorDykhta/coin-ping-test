import { Button, cn } from "@sqlrooms/ui";

import { AMBIENT_CAPTURE_MS } from "../lib/ambient";
import type { AmbientProfile } from "../lib/ambient";

type AmbientControlsProps = {
  isListening: boolean;
  isCapturingAmbient: boolean;
  ambientProgress: number;
  ambientProfile: AmbientProfile | null;
  subtractAmbientEnabled: boolean;
  onStartCapture: () => void;
  onClearAmbient: () => void;
  onSubtractChange: (enabled: boolean) => void;
};

export function AmbientControls({
  isListening,
  isCapturingAmbient,
  ambientProgress,
  ambientProfile,
  subtractAmbientEnabled,
  onStartCapture,
  onClearAmbient,
  onSubtractChange,
}: AmbientControlsProps) {
  const captureSeconds = AMBIENT_CAPTURE_MS / 1000;
  const progressPct = Math.round(ambientProgress * 100);

  return (
    <div className="rounded-md border border-border bg-card/50 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Ambient calibration</p>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-border"
            checked={subtractAmbientEnabled}
            disabled={!ambientProfile}
            onChange={(event) => onSubtractChange(event.target.checked)}
          />
          <span className={cn(!ambientProfile && "text-muted-foreground")}>
            Subtract ambient
          </span>
        </label>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        Capture {captureSeconds}s of room noise. Subtraction removes ~55% of the measured floor
        and keeps a low residual so coin pings stand out without blanking the chart.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!isListening || isCapturingAmbient}
          onClick={onStartCapture}
        >
          {isCapturingAmbient ? `Capturing… ${progressPct}%` : `Capture ambient (${captureSeconds}s)`}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!ambientProfile || isCapturingAmbient}
          onClick={onClearAmbient}
        >
          Clear ambient
        </Button>
      </div>

      {isCapturingAmbient ? (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-amber-500 transition-[width] duration-150"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      ) : null}

      {ambientProfile ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Profile ready: {ambientProfile.values.length} bins, mean power over{" "}
          {ambientProfile.frameCount} frames · {new Date(ambientProfile.capturedAt).toLocaleTimeString()}
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No ambient profile — showing raw spectrum.</p>
      )}
    </div>
  );
}
