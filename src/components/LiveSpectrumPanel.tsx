import { useMemo } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, cn } from "@sqlrooms/ui";

import { useAudioCapture } from "../hooks/useAudioCapture";
import {
  ANALYZER_MAX_DB,
  ANALYZER_MIN_DB,
  detectPeaks,
  LIVE_ANALYZER_MAX_DB,
  LIVE_ANALYZER_MIN_DB,
  LIVE_DISPLAY_BOOST_DB,
} from "../lib/spectrum";
import { SpectrumChart } from "./SpectrumChart";

export function LiveSpectrumPanel() {
  const {
    isListening,
    isRecording,
    liveSpectrum,
    recordingSpectrum,
    error: captureError,
    startListening,
    stopListening,
    startRecording,
    stopRecording,
    clearRecording,
  } = useAudioCapture();

  const recordingPeaks = useMemo(
    () => (recordingSpectrum ? detectPeaks(recordingSpectrum) : []),
    [recordingSpectrum],
  );

  const displaySpectrum = recordingSpectrum ?? liveSpectrum;
  const chartTitle = recordingSpectrum
    ? "Recording spectrum"
    : isRecording
      ? "Live (recording…)"
      : isListening
        ? "Live microphone"
        : undefined;

  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle>Frequency spectrum</CardTitle>
        <div className="flex flex-wrap gap-2">
          {!isListening ? (
            <Button type="button" onClick={() => void startListening()}>
              Start listening
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => void stopListening()}>
                Stop
              </Button>
              {!isRecording ? (
                <Button type="button" onClick={startRecording}>
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
        <p
          className={cn(
            "text-sm",
            isRecording ? "text-amber-400" : "text-muted-foreground",
          )}
        >
          {!isListening
            ? "Start listening to see live frequencies from the microphone."
            : isRecording
              ? "Recording… strike the coin, then stop to analyze the ping."
              : recordingSpectrum
                ? `Showing spectrum for the last recording (${recordingPeaks.length} peaks detected).`
                : "Ambient noise shows as steady bars; coin pings spike upward."}
        </p>

        <div className="min-h-0 flex-1 rounded-md border border-border bg-card">
          <SpectrumChart
            key={recordingSpectrum ? "recording" : "live"}
            spectrum={displaySpectrum}
            peaks={recordingSpectrum ? recordingPeaks : []}
            title={chartTitle}
            minDb={recordingSpectrum ? ANALYZER_MIN_DB : LIVE_ANALYZER_MIN_DB}
            maxDb={recordingSpectrum ? ANALYZER_MAX_DB : LIVE_ANALYZER_MAX_DB}
            displayBoostDb={recordingSpectrum ? 0 : LIVE_DISPLAY_BOOST_DB}
            logFrequency
            peakHold={!recordingSpectrum}
          />
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
