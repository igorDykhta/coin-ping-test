import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
} from "@sqlrooms/ui";

import { AmbientControls } from "./AmbientControls";
import { FrequencyRangeControls } from "./FrequencyRangeControls";
import { SpectrumChart } from "./SpectrumChart";
import { useAudioCapture } from "../hooks/useAudioCapture";
import { useFrequencyRange } from "../hooks/useFrequencyRange";
import type { DetectedPing } from "../lib/pingDetector";
import { getReferenceColor } from "../lib/referenceColors";
import type { ReferenceRecord } from "../types/coinPing";
import {
  AMBIENT_SUBTRACT_MAX_DB,
  AMBIENT_SUBTRACT_MIN_DB,
  ANALYZER_MAX_DB,
  ANALYZER_MIN_DB,
  detectPeaks,
  FFT_SIZE,
  LIVE_ANALYZER_MAX_DB,
  LIVE_ANALYZER_MIN_DB,
  LIVE_DISPLAY_BOOST_DB,
  nyquistHz,
  PING_DETECTION_MIN_HZ,
  resolveFftSizeForSpan,
} from "../lib/spectrum";
import { AMBIENT_CAPTURE_MS } from "../lib/ambient";

export type DetectedPingsExternalState = {
  pings: DetectedPing[];
  enabled: boolean;
  clearAll: () => void;
  dismiss: (id: string) => void;
  manualRecording?: DetectedPing;
};

export type SoundControls = {
  isRecording: boolean;
  finishRecording: () => Promise<void>;
  stopListening: () => Promise<void>;
};

type LiveSpectrumPanelProps = {
  onDetectedPingsChange?: (state: DetectedPingsExternalState) => void;
  onSoundControlsChange?: (controls: SoundControls) => void;
  /**
   * Saved reference recordings whose peak frequencies should be highlighted on
   * the chart. All peaks from all selected references are overlaid together so
   * the user can compare several presets at once.
   */
  selectedReferences?: readonly ReferenceRecord[];
};

export function LiveSpectrumPanel({
  onDetectedPingsChange,
  onSoundControlsChange,
  selectedReferences = [],
}: LiveSpectrumPanelProps = {}) {
  const [desiredFftSize, setDesiredFftSize] = useState<number>(FFT_SIZE);
  const [pingDetectionEnabled, setPingDetectionEnabled] = useState<boolean>(true);
  const [allowLowFreqDetection, setAllowLowFreqDetection] = useState<boolean>(false);
  const [sampleRate, setSampleRate] = useState<number | null>(null);

  const { minHz, maxHz, setRange, resetRange } = useFrequencyRange(sampleRate);

  // By default, detection ignores everything below ~4 kHz so keyboard/touchpad
  // /mouse mechanical noise (mostly low-frequency) doesn't fire spurious pings.
  // The user can opt in to low-frequency detection via the toggle.
  const detectionMinHz = allowLowFreqDetection
    ? minHz
    : Math.max(minHz, PING_DETECTION_MIN_HZ);
  const detectionMaxHz = maxHz;
  const detectionBandValid = detectionMaxHz > detectionMinHz;

  const {
    isStarting,
    isListening,
    isRecording,
    isCapturingAmbient,
    ambientProgress,
    ambientProfile,
    subtractAmbientEnabled,
    setSubtractAmbientEnabled,
    liveSpectrum,
    recordingSpectrum,
    error: captureError,
    startListening,
    stopListening,
    startAmbientCapture,
    clearAmbientProfile,
    startRecording,
    stopRecording,
    clearRecording,
    detectedPings,
    clearDetectedPings,
    dismissDetectedPing,
    addManualPeak,
    chartOverlays,
    pingCaptureProgress,
  } = useAudioCapture({
    fftSize: desiredFftSize,
    pingDetectionEnabled: pingDetectionEnabled && detectionBandValid,
    pingDetectionMinHz: detectionMinHz,
    pingDetectionMaxHz: detectionMaxHz,
  });

  // Latest detected ping; its captured max-hold spectrum is overlaid on the
  // live chart as a line trace so the user can compare it with the now-decayed
  // live signal.
  const latestPing = detectedPings[detectedPings.length - 1] ?? null;

  const chartOverlaySpectrum =
    chartOverlays?.spectrum ?? latestPing?.spectrum ?? null;
  const chartAccumulatedOverlay =
    chartOverlays?.accumulated ?? latestPing?.accumulatedSpectrum ?? null;

  // Frequency under the cursor at the moment of right-click — captured by the
  // chart and consumed by the context-menu items below.
  const contextMenuFrequencyRef = useRef<number | null>(null);
  const [contextMenuFrequency, setContextMenuFrequency] = useState<
    number | null
  >(null);
  const handleChartContextMenu = useCallback((hz: number) => {
    contextMenuFrequencyRef.current = hz;
    setContextMenuFrequency(hz);
  }, []);
  const handleAddManualPeak = useCallback(
    (kind: "long" | "short") => {
      const hz = contextMenuFrequencyRef.current;
      if (hz === null) return;
      addManualPeak(hz, kind);
    },
    [addManualPeak],
  );

  const displaySpectrum = recordingSpectrum ?? liveSpectrum;
  const maxAudibleHz = sampleRate ? Math.floor(sampleRate / 2) : null;
  const lowSampleRate = sampleRate !== null && sampleRate < 44_100;

  // Merge peak frequencies from every selected reference so they are all drawn
  // as blue tolerance bands on the chart simultaneously. Each peak is tagged
  // with the reference's stable color so the chart can also draw a colored
  // marker circle to distinguish presets.
  const referenceLines = useMemo(() => {
    if (selectedReferences.length === 0) return undefined;
    const lines: { frequencyHz: number; color: string }[] = [];
    for (const ref of selectedReferences) {
      const color = getReferenceColor(ref.id);
      for (const peak of ref.peaks) {
        lines.push({ frequencyHz: peak.frequencyHz, color });
      }
    }
    return lines;
  }, [selectedReferences]);

  useEffect(() => {
    const next = displaySpectrum?.sampleRate ?? null;
    setSampleRate((prev) => (prev === next ? prev : next));
  }, [displaySpectrum]);

  useEffect(() => {
    if (sampleRate === null) {
      return;
    }
    const next = resolveFftSizeForSpan(maxHz - minHz, sampleRate);
    setDesiredFftSize((prev) => (prev === next ? prev : next));
  }, [minHz, maxHz, sampleRate]);

  const applyRange = useCallback(
    (nextMinHz: number, nextMaxHz: number) => {
      if (nextMinHz !== minHz || nextMaxHz !== maxHz) {
        clearAmbientProfile();
      }
      setRange(nextMinHz, nextMaxHz);
    },
    [minHz, maxHz, setRange, clearAmbientProfile],
  );

  const resetRangeAndAmbient = useCallback(() => {
    clearAmbientProfile();
    resetRange();
  }, [clearAmbientProfile, resetRange]);

  const usesAmbientScale = Boolean(
    displaySpectrum?.ambientSubtracted && subtractAmbientEnabled && ambientProfile,
  );

  const recordingPeaks = useMemo(
    () =>
      recordingSpectrum
        ? detectPeaks(recordingSpectrum, {
            minHz,
            maxHz,
            minDb: recordingSpectrum.ambientSubtracted ? -55 : -70,
          })
        : [],
    [recordingSpectrum, minHz, maxHz],
  );

  // Show the latest ping's peaks as vertical lines, regardless of whether
  // the user is currently viewing the live or the frozen ping spectrum.
  const latestPingPeaks = useMemo(() => {
    if (recordingSpectrum) return [];
    return latestPing?.peaks ?? [];
  }, [latestPing, recordingSpectrum]);

  const chartPeaks = recordingSpectrum ? recordingPeaks : latestPingPeaks;

  const manualRecording = useMemo<DetectedPing | undefined>(() => {
    if (!recordingSpectrum || recordingPeaks.length === 0) return undefined;
    return {
      id: `recording-${Date.now()}`,
      detectedAt: new Date().toISOString(),
      spectrum: recordingSpectrum,
      peaks: recordingPeaks,
      ambientSubtracted: recordingSpectrum.ambientSubtracted ?? false,
      triggerBandDb: 0,
      baselineBandDb: 0,
      topPeakSustainMs: 0,
    };
  }, [recordingSpectrum, recordingPeaks]);

  useEffect(() => {
    onSoundControlsChange?.({ isRecording, finishRecording: stopRecording, stopListening });
  }, [isRecording, onSoundControlsChange, stopListening, stopRecording]);

  // Stream the current detection state out to the parent so the pings list
  // can live elsewhere in the layout (left column under references).
  const detectionEnabledForList = pingDetectionEnabled && isListening;
  useEffect(() => {
    onDetectedPingsChange?.({
      pings: detectedPings,
      enabled: detectionEnabledForList,
      clearAll: clearDetectedPings,
      dismiss: dismissDetectedPing,
      manualRecording,
    });
  }, [
    detectedPings,
    detectionEnabledForList,
    clearDetectedPings,
    dismissDetectedPing,
    onDetectedPingsChange,
    manualRecording,
  ]);

  const chartTitle = recordingSpectrum
    ? subtractAmbientEnabled && ambientProfile
      ? "Recording (ambient subtracted)"
      : "Recording spectrum"
    : isRecording
      ? "Live (recording…)"
      : isCapturingAmbient
        ? "Capturing ambient…"
        : isListening
          ? subtractAmbientEnabled && ambientProfile
            ? "Live (ambient subtracted)"
            : "Live microphone"
          : undefined;

  const nyquist = sampleRate ? nyquistHz(sampleRate) : 24_000;

  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle>Frequency spectrum</CardTitle>
        <div className="flex flex-wrap gap-2">
          {!isListening ? (
            <Button
              type="button"
              onClick={() => void (isStarting ? stopListening() : startListening())}
            >
              {isStarting ? "Cancel microphone request" : "Start listening"}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => void stopListening()}>
                Stop
              </Button>
              <Button
                type="button"
                variant={pingDetectionEnabled ? "default" : "outline"}
                onClick={() => setPingDetectionEnabled((prev) => !prev)}
                disabled={isCapturingAmbient || !detectionBandValid}
                title={
                  detectionBandValid
                    ? `Auto-detect transient spikes (band: ${Math.round(detectionMinHz)}–${Math.round(detectionMaxHz)} Hz)`
                    : allowLowFreqDetection
                      ? "Visible band is empty — adjust zoom."
                      : `Zoom in above ${PING_DETECTION_MIN_HZ} Hz, or enable low-freq detection`
                }
              >
                Auto-detect: {pingDetectionEnabled ? "on" : "off"}
              </Button>
              <Button
                type="button"
                variant={allowLowFreqDetection ? "destructive" : "outline"}
                onClick={() => setAllowLowFreqDetection((prev) => !prev)}
                title={
                  allowLowFreqDetection
                    ? "Detection floor is the visible band's min — keyboard/touchpad noise can trigger pings"
                    : `Detection floor is ${PING_DETECTION_MIN_HZ} Hz (filters low-frequency mechanical noise)`
                }
              >
                Low-freq: {allowLowFreqDetection ? "on" : "off"}
              </Button>
              {!isRecording ? (
                <Button
                  type="button"
                  onClick={startRecording}
                  disabled={isCapturingAmbient}
                >
                  Record ping
                </Button>
              ) : (
                <Button type="button" variant="destructive" onClick={() => void stopRecording()}>
                  Stop recording
                </Button>
              )}
              {recordingSpectrum ? (
                <Button type="button" variant="outline" onClick={clearRecording}>
                  Clear recording
                </Button>
              ) : null}
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <FrequencyRangeControls
          minHz={minHz}
          maxHz={maxHz}
          nyquistHz={nyquist}
          onApply={applyRange}
          onReset={resetRangeAndAmbient}
        />

        <AmbientControls
          isListening={isListening}
          isCapturingAmbient={isCapturingAmbient}
          ambientProgress={ambientProgress}
          ambientProfile={ambientProfile}
          subtractAmbientEnabled={subtractAmbientEnabled}
          onStartCapture={startAmbientCapture}
          onClearAmbient={clearAmbientProfile}
          onSubtractChange={setSubtractAmbientEnabled}
        />

        {sampleRate !== null ? (
          <p
            className={cn(
              "text-xs",
              lowSampleRate ? "text-amber-400" : "text-muted-foreground",
            )}
          >
            Audio sample rate: {Math.round(sampleRate / 1000)} kHz (max frequency ~
            {Math.round((maxAudibleHz ?? 0) / 1000)} kHz).
            {lowSampleRate
              ? " Switch input device or disable Bluetooth headset to get full bandwidth."
              : null}
          </p>
        ) : null}

        {isListening && desiredFftSize > FFT_SIZE && sampleRate !== null ? (
          <p className="text-xs text-muted-foreground">
            Zoom uses FFT {desiredFftSize} (~{(sampleRate / desiredFftSize).toFixed(1)} Hz/bin) for
            finer resolution; response is slightly slower than the default FFT {FFT_SIZE}.
          </p>
        ) : null}

        {pingCaptureProgress ? null : (
          <p
            className={cn(
              "text-sm",
              isRecording ? "text-amber-400" : "text-muted-foreground",
            )}
          >
            {!isListening
              ? "Start listening, capture ambient, then record coin pings."
              : isCapturingAmbient
                ? `Keep the room quiet for ${AMBIENT_CAPTURE_MS / 1000} seconds while we measure background noise.`
                : isRecording
                  ? "Recording… strike the coin, then stop to analyze the ping."
                  : recordingSpectrum
                    ? `Showing spectrum for the last recording (${recordingPeaks.length} peaks detected).`
                    : ambientProfile && subtractAmbientEnabled
                      ? latestPing || chartOverlaySpectrum || chartAccumulatedOverlay
                        ? "Green = peak snapshot · red = time-averaged sustained resonance."
                        : "Live view shows signal minus ambient floor; coin pings stand out above zero."
                      : latestPing || chartOverlaySpectrum || chartAccumulatedOverlay
                        ? "Green = peak snapshot · red = time-averaged sustained resonance."
                        : "Capture ambient first, then coin pings spike above the noise floor."}
          </p>
        )}

        <div className="relative min-h-0 flex-1 rounded-md border border-border bg-card">
          <ContextMenu
            onOpenChange={(open) => {
              if (!open) setContextMenuFrequency(null);
            }}
          >
            <ContextMenuTrigger asChild>
              <div className="h-full w-full">
                <SpectrumChart
                  key={recordingSpectrum ? "recording" : "live"}
                  spectrum={displaySpectrum}
                  peaks={chartPeaks}
                  onRangeChange={recordingSpectrum ? undefined : setRange}
                  onContextMenuFrequency={
                    recordingSpectrum ? undefined : handleChartContextMenu
                  }
                  title={chartTitle}
                  minDb={
                    usesAmbientScale
                      ? AMBIENT_SUBTRACT_MIN_DB
                      : recordingSpectrum
                        ? ANALYZER_MIN_DB
                        : LIVE_ANALYZER_MIN_DB
                  }
                  maxDb={
                    usesAmbientScale
                      ? AMBIENT_SUBTRACT_MAX_DB
                      : recordingSpectrum
                        ? ANALYZER_MAX_DB
                        : LIVE_ANALYZER_MAX_DB
                  }
                  displayBoostDb={
                    usesAmbientScale || recordingSpectrum
                      ? 0
                      : LIVE_DISPLAY_BOOST_DB
                  }
                  minHz={minHz}
                  maxHz={maxHz}
                  logFrequency
                  peakHold={!recordingSpectrum}
                  overlaySpectrum={
                    recordingSpectrum ? null : chartOverlaySpectrum
                  }
                  accumulatedOverlaySpectrum={
                    recordingSpectrum ? null : chartAccumulatedOverlay
                  }
                  referenceLines={referenceLines}
                  captureWindow={
                    pingCaptureProgress
                      ? {
                          startedAtMs: pingCaptureProgress.startedAtMs,
                          totalMs: pingCaptureProgress.totalMs,
                        }
                      : null
                  }
                  isRecordingActive={isRecording && !recordingSpectrum}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <div className="px-2 py-1 text-[11px] text-muted-foreground">
                {contextMenuFrequency !== null
                  ? `${Math.round(contextMenuFrequency)} Hz`
                  : "—"}
              </div>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={contextMenuFrequency === null}
                onSelect={() => handleAddManualPeak("long")}
              >
                Add long peak
              </ContextMenuItem>
              <ContextMenuItem
                disabled={contextMenuFrequency === null}
                onSelect={() => handleAddManualPeak("short")}
              >
                Add short peak
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>

        {recordingPeaks.length > 0 ? (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Resonances: </span>
            {recordingPeaks
              .map((p) => `${Math.round(p.frequencyHz)} Hz (${p.magnitude.toFixed(1)} dB)`)
              .join(" · ")}
          </div>
        ) : null}

        {captureError ? <p className="text-sm text-red-500">{captureError}</p> : null}
      </CardContent>
    </Card>
  );
}
