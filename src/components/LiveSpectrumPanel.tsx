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
  Input,
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
  clampFrequencyRange,
  detectPeaks,
  FFT_SIZE,
  LIVE_ANALYZER_MAX_DB,
  LIVE_ANALYZER_MIN_DB,
  LIVE_DISPLAY_BOOST_DB,
  ABSOLUTE_MAX_DISPLAY_HZ,
  nyquistHz,
  PING_DETECTION_MIN_HZ,
  resolveFftSizeForSpan,
} from "../lib/spectrum";
import { AMBIENT_CAPTURE_MS } from "../lib/ambient";

export type DetectedPingsExternalState = {
  pings: DetectedPing[];
  enabled: boolean;
  inactiveMessage?: string;
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

function ManualPeakEntry({ maxHz, onAdd }: {
  maxHz: number;
  onAdd: (frequency: number, kind: "long" | "short") => void;
}) {
  const [frequency, setFrequency] = useState("");
  const [kind, setKind] = useState<"long" | "short">("long");
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null);

  return (
    <details className="rounded-md border border-border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">Enter a peak manually</summary>
      <form className="mt-2 space-y-2" noValidate onSubmit={(event) => {
        event.preventDefault();
        const hz = Number(frequency);
        if (!Number.isFinite(hz) || hz < 1 || hz > maxHz) {
          setFeedback({ text: `Enter a frequency from 1 to ${maxHz} Hz.`, error: true });
          return;
        }
        onAdd(hz, kind);
        setFrequency("");
        setFeedback({ text: `Added ${hz} Hz to the latest ping.` });
      }}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Peak frequency (Hz)
            <Input type="number" inputMode="decimal" step="any" min={1} max={maxHz} required
              value={frequency} onChange={(event) => { setFrequency(event.currentTarget.value); setFeedback(null); }}
              className="h-8 w-36 font-mono text-foreground" />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Peak duration
            <select value={kind} onChange={(event) => setKind(event.currentTarget.value === "short" ? "short" : "long")}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground">
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </label>
          <Button type="submit" size="sm" variant="outline">Add peak</Button>
        </div>
        {feedback ? <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "text-xs text-red-400" : "text-xs text-muted-foreground"}>
          {feedback.text}
        </p> : null}
      </form>
    </details>
  );
}

export function LiveSpectrumPanel({
  onDetectedPingsChange,
  onSoundControlsChange,
  selectedReferences = [],
}: LiveSpectrumPanelProps = {}) {
  const [pingDetectionEnabled, setPingDetectionEnabled] = useState<boolean>(true);
  const [allowLowFreqDetection, setAllowLowFreqDetection] = useState<boolean>(false);
  const [liveSampleRate, setLiveSampleRate] = useState<number | null>(null);
  const [reviewingRecording, setReviewingRecording] = useState(false);

  const { minHz: preferredMinHz, maxHz: preferredMaxHz, setRange, resetRange } = useFrequencyRange();
  const liveRate = liveSampleRate ?? 48_000;
  const liveRange = clampFrequencyRange(preferredMinHz, preferredMaxHz, liveRate);
  const desiredFftSize = resolveFftSizeForSpan(liveRange.maxHz - liveRange.minHz, liveRate);

  // By default, detection ignores everything below ~4 kHz so keyboard/touchpad
  // /mouse mechanical noise (mostly low-frequency) doesn't fire spurious pings.
  // The user can opt in to low-frequency detection via the toggle.
  const detectionMinHz = allowLowFreqDetection
    ? liveRange.minHz
    : Math.max(liveRange.minHz, PING_DETECTION_MIN_HZ);
  const detectionMaxHz = liveRange.maxHz;
  const detectionBandValid = detectionMaxHz > detectionMinHz;

  const {
    isStarting,
    isListening,
    isRecording,
    isFinalizingRecording,
    isCapturingAmbient,
    ambientProgress,
    ambientProfile,
    subtractAmbientEnabled,
    setSubtractAmbientEnabled,
    liveSpectrum,
    recordingSpectrum,
    recordingBlob,
    recordingIdentity,
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

  const reportedLiveRate = liveSpectrum?.sampleRate ?? null;
  useEffect(() => setLiveSampleRate(reportedLiveRate), [reportedLiveRate]);

  // A newly analyzed take opens its recording view. Starting a new microphone
  // session returns to live view, while keeping the last take available.
  useEffect(() => {
    if (recordingSpectrum) setReviewingRecording(true);
  }, [recordingSpectrum]);
  useEffect(() => {
    if (isListening) setReviewingRecording(false);
  }, [isListening]);

  const recordingView = Boolean(recordingSpectrum && (!isListening || reviewingRecording));
  const displaySpectrum = recordingView ? recordingSpectrum : liveSpectrum;
  const displaySampleRate = displaySpectrum?.sampleRate ?? null;
  const recordingRate = recordingSpectrum?.sampleRate;
  const recordingRange = useMemo(
    () => recordingRate === undefined
      ? null
      : clampFrequencyRange(preferredMinHz, preferredMaxHz, recordingRate),
    [preferredMinHz, preferredMaxHz, recordingRate],
  );
  const { minHz, maxHz } = (recordingView && recordingRange) || liveRange;
  const nyquist = nyquistHz(displaySampleRate ?? liveRate);

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

  const usesAmbientScale = Boolean(displaySpectrum?.ambientSubtracted);

  const recordingPeaks = useMemo(
    () =>
      recordingSpectrum && recordingRange
        ? detectPeaks(recordingSpectrum, {
            ...recordingRange,
            minDb: recordingSpectrum.ambientSubtracted ? -55 : -70,
          })
        : [],
    [recordingSpectrum, recordingRange],
  );

  // Each view shows the peaks measured from its corresponding spectrum.
  const latestPingPeaks = useMemo(() => latestPing?.peaks ?? [], [latestPing]);
  const chartPeaks = recordingView ? recordingPeaks : latestPingPeaks;

  const manualRecording = useMemo<DetectedPing | undefined>(() => {
    if (!recordingSpectrum || !recordingIdentity) return undefined;
    const audioClip = recordingBlob?.size ? recordingBlob : undefined;
    if (!audioClip && recordingPeaks.length === 0) return undefined;
    return {
      id: recordingIdentity.id,
      detectedAt: recordingIdentity.capturedAt,
      audioClip,
      spectrum: recordingSpectrum,
      peaks: recordingPeaks,
      ambientSubtracted: recordingSpectrum.ambientSubtracted ?? false,
    };
  }, [recordingSpectrum, recordingIdentity, recordingBlob, recordingPeaks]);

  useEffect(() => {
    onSoundControlsChange?.({ isRecording, finishRecording: stopRecording, stopListening });
  }, [isRecording, onSoundControlsChange, stopListening, stopRecording]);

  // Stream the current detection state out to the parent so the pings list
  // can live elsewhere in the layout (left column under references).
  const detectionEnabledForList = pingDetectionEnabled && isListening && detectionBandValid && !isCapturingAmbient;
  let detectionInactiveMessage: string | undefined;
  if (isListening) {
    if (isCapturingAmbient) detectionInactiveMessage = "Detection paused during ambient calibration.";
    else if (!detectionBandValid) detectionInactiveMessage = "Adjust the frequency range or enable low-frequency detection.";
    else if (!pingDetectionEnabled) detectionInactiveMessage = "Auto-detection is off.";
  }
  useEffect(() => {
    onDetectedPingsChange?.({
      pings: detectedPings,
      enabled: detectionEnabledForList,
      inactiveMessage: detectionInactiveMessage,
      clearAll: clearDetectedPings,
      dismiss: dismissDetectedPing,
      manualRecording,
    });
  }, [
    detectedPings,
    detectionEnabledForList,
    detectionInactiveMessage,
    clearDetectedPings,
    dismissDetectedPing,
    onDetectedPingsChange,
    manualRecording,
  ]);

  const chartTitle = recordingView
    ? displaySpectrum?.ambientSubtracted
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

  let workspaceStatus = "Capture ambient first, then coin pings spike above the noise floor.";
  if (isFinalizingRecording) {
    workspaceStatus = "Analyzing recording…";
  } else if (recordingView) {
    workspaceStatus = `Showing spectrum for the last recording (${recordingPeaks.length} peaks detected).`;
  } else if (!isListening) {
    workspaceStatus = "Start listening, capture ambient, then record coin pings.";
  } else if (isCapturingAmbient) {
    workspaceStatus = `Keep the room quiet for ${AMBIENT_CAPTURE_MS / 1000} seconds while we measure background noise.`;
  } else if (isRecording) {
    workspaceStatus = "Recording… strike the coin, then stop to analyze the ping.";
  } else if (latestPing || chartOverlaySpectrum || chartAccumulatedOverlay) {
    workspaceStatus = "Green = peak snapshot · red = time-averaged sustained resonance.";
  } else if (ambientProfile && subtractAmbientEnabled) {
    workspaceStatus = "Live view shows signal minus ambient floor; coin pings stand out above zero.";
  }

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
                  disabled={isCapturingAmbient || isFinalizingRecording}
                >
                  Record ping
                </Button>
              ) : (
                <Button type="button" variant="destructive" onClick={() => void stopRecording()}>
                  Stop recording
                </Button>
              )}
            </>
          )}
          {isListening && recordingSpectrum ? (
            <Button type="button" variant="outline" onClick={() => setReviewingRecording(!recordingView)}>
              {recordingView ? "Show live spectrum" : "Show recording"}
            </Button>
          ) : null}
          {recordingSpectrum || recordingBlob ? (
            <Button type="button" variant="outline" onClick={clearRecording}>
              Clear recording
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Frequency range and ambient settings</summary>
          <div className="mt-3 space-y-3">
            <FrequencyRangeControls
              minHz={minHz}
              maxHz={maxHz}
              nyquistHz={nyquist}
              isRecordingView={recordingView}
              onApply={applyRange}
              onReset={resetRangeAndAmbient}
            />

            <AmbientControls
              isListening={isListening}
              isCapturingAmbient={isCapturingAmbient}
              captureBlocked={isRecording || isFinalizingRecording}
              ambientProgress={ambientProgress}
              ambientProfile={ambientProfile}
              subtractAmbientEnabled={subtractAmbientEnabled}
              onStartCapture={startAmbientCapture}
              onClearAmbient={clearAmbientProfile}
              onSubtractChange={setSubtractAmbientEnabled}
            />
          </div>
        </details>

        {displaySampleRate !== null ? (
          <p
            className={cn(
              "text-xs",
              !recordingView && displaySampleRate < 44_100 ? "text-amber-400" : "text-muted-foreground",
            )}
          >
            {recordingView ? "Recording sample rate" : "Audio sample rate"}: {Math.round(displaySampleRate / 1000)} kHz (max frequency ~
            {Math.round(nyquist / 1000)} kHz).
            {!recordingView && displaySampleRate < 44_100
              ? " Switch input device or disable Bluetooth headset to get full bandwidth."
              : null}
          </p>
        ) : null}

        {isListening && !recordingView && desiredFftSize > FFT_SIZE && liveSampleRate !== null ? (
          <p className="text-xs text-muted-foreground">
            Zoom uses FFT {desiredFftSize} (~{(liveSampleRate / desiredFftSize).toFixed(1)} Hz/bin) for
            finer resolution; response is slightly slower than the default FFT {FFT_SIZE}.
          </p>
        ) : null}

        {!recordingView && pingCaptureProgress ? null : (
          <p
            className={cn(
              "text-sm",
              isRecording ? "text-amber-400" : "text-muted-foreground",
            )}
          >
            {workspaceStatus}
          </p>
        )}

        <div role="region" aria-label={recordingView ? "Recording spectrum" : "Live spectrum"}
          className="relative min-h-[320px] flex-1 rounded-md border border-border bg-card">
          <ContextMenu
            onOpenChange={(open) => {
              if (!open) setContextMenuFrequency(null);
            }}
          >
            <ContextMenuTrigger asChild>
              <div className="h-full w-full">
                <SpectrumChart
                  key={recordingView ? "recording" : "live"}
                  spectrum={displaySpectrum}
                  peaks={chartPeaks}
                  onRangeChange={recordingView ? undefined : setRange}
                  onContextMenuFrequency={
                    recordingView ? undefined : handleChartContextMenu
                  }
                  title={chartTitle}
                  minDb={
                    usesAmbientScale
                      ? AMBIENT_SUBTRACT_MIN_DB
                      : recordingView
                        ? ANALYZER_MIN_DB
                        : LIVE_ANALYZER_MIN_DB
                  }
                  maxDb={
                    usesAmbientScale
                      ? AMBIENT_SUBTRACT_MAX_DB
                      : recordingView
                        ? ANALYZER_MAX_DB
                        : LIVE_ANALYZER_MAX_DB
                  }
                  displayBoostDb={
                    usesAmbientScale || recordingView
                      ? 0
                      : LIVE_DISPLAY_BOOST_DB
                  }
                  minHz={minHz}
                  maxHz={maxHz}
                  logFrequency
                  peakHold={!recordingView}
                  overlaySpectrum={
                    recordingView ? null : chartOverlaySpectrum
                  }
                  accumulatedOverlaySpectrum={
                    recordingView ? null : chartAccumulatedOverlay
                  }
                  referenceLines={referenceLines}
                  captureWindow={
                    !recordingView && pingCaptureProgress
                      ? {
                          startedAtMs: pingCaptureProgress.startedAtMs,
                          totalMs: pingCaptureProgress.totalMs,
                        }
                      : null
                  }
                  isRecordingActive={isRecording && !recordingView}
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

        {recordingView && recordingPeaks.length > 0 ? (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Resonances: </span>
            {recordingPeaks
              .map((p) => `${Math.round(p.frequencyHz)} Hz (${p.magnitude.toFixed(1)} dB)`)
              .join(" · ")}
          </div>
        ) : null}

        {!recordingView ? <ManualPeakEntry maxHz={Math.min(ABSOLUTE_MAX_DISPLAY_HZ, Math.floor(nyquist))} onAdd={addManualPeak} /> : null}

        {captureError ? <p role="alert" className="text-sm text-red-400">{captureError}</p> : null}
      </CardContent>
    </Card>
  );
}
