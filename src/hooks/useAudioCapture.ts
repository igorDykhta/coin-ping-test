import { useCallback, useEffect, useRef, useState } from "react";

import {
  accumulateAmbientFrame,
  AMBIENT_CAPTURE_MS,
  applyAmbientToSpectrumData,
  createAmbientAccumulator,
  finalizeAmbientProfile,
  isAmbientCompatible,
  subtractAmbientInto,
  type AmbientProfile,
} from "../lib/ambient";
import {
  computeSpectrumFromBuffer,
  FFT_SIZE,
  LIVE_INPUT_GAIN,
  type SpectrumData,
} from "../lib/spectrum";
import {
  createPingDetector,
  isDuplicatePing,
  type DetectedPing,
  type PingCaptureOverlays,
  type PingCaptureProgress,
  type PingDetector,
} from "../lib/pingDetector";
import type { ResonancePeak } from "../types/coinPing";

/** Limit React spectrum updates (~20 fps) to avoid memory pressure. */
const LIVE_UI_INTERVAL_MS = 50;
const AMBIENT_UI_INTERVAL_MS = 100;
const MAX_RECORDING_MS = 60_000;
const MAX_DETECTED_PINGS = 50;

function cloneSpectrumData(spectrum: SpectrumData): SpectrumData {
  return {
    values: new Float32Array(spectrum.values),
    sampleRate: spectrum.sampleRate,
    fftSize: spectrum.fftSize,
    ambientSubtracted: spectrum.ambientSubtracted,
  };
}

function cloneCaptureOverlays(
  overlays: PingCaptureOverlays,
): PingCaptureOverlays {
  return {
    spectrum: cloneSpectrumData(overlays.spectrum),
    accumulated: overlays.accumulated
      ? cloneSpectrumData(overlays.accumulated)
      : null,
  };
}

function mergeCaptureOverlays(
  spectrum: SpectrumData,
  accumulated: SpectrumData | null | undefined,
  fallback: PingCaptureOverlays | null,
): PingCaptureOverlays {
  return {
    spectrum: cloneSpectrumData(spectrum),
    accumulated: accumulated
      ? cloneSpectrumData(accumulated)
      : fallback?.accumulated
        ? cloneSpectrumData(fallback.accumulated)
        : null,
  };
}

type AudioCaptureState = {
  isStarting: boolean;
  isListening: boolean;
  isRecording: boolean;
  isCapturingAmbient: boolean;
  ambientProgress: number;
  liveSpectrum: SpectrumData | null;
  recordingSpectrum: SpectrumData | null;
  recordingBlob: Blob | null;
  error: string | null;
};

const initialState: AudioCaptureState = {
  isStarting: false,
  isListening: false,
  isRecording: false,
  isCapturingAmbient: false,
  ambientProgress: 0,
  liveSpectrum: null,
  recordingSpectrum: null,
  recordingBlob: null,
  error: null,
};

export type UseAudioCaptureOptions = {
  /** Live analyser FFT size. Changing this re-creates the analyser and clears ambient. */
  fftSize?: number;
  /** When true, run automatic ping detection in the live loop. */
  pingDetectionEnabled?: boolean;
  /** Lower edge of the detection band (Hz). Should match the chart's visible range. */
  pingDetectionMinHz?: number;
  /** Upper edge of the detection band (Hz). Should match the chart's visible range. */
  pingDetectionMaxHz?: number;
};

export function useAudioCapture(options: UseAudioCaptureOptions = {}) {
  const {
    fftSize: requestedFftSize = FFT_SIZE,
    pingDetectionEnabled = false,
    pingDetectionMinHz,
    pingDetectionMaxHz,
  } = options;
  const [state, setState] = useState<AudioCaptureState>(initialState);
  const [ambientProfile, setAmbientProfile] = useState<AmbientProfile | null>(null);
  const [subtractAmbientEnabled, setSubtractAmbientEnabled] = useState(true);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startRequestRef = useRef<symbol | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const floatBufferRef = useRef<Float32Array | null>(null);
  const liveValuesRef = useRef<Float32Array | null>(null);
  const lastLiveUiUpdateRef = useRef(0);
  const lastAmbientUiUpdateRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const mountedRef = useRef(true);

  const ambientProfileRef = useRef<AmbientProfile | null>(null);
  const subtractEnabledRef = useRef(true);
  const capturingAmbientRef = useRef(false);
  const ambientCaptureStartRef = useRef(0);
  const ambientSumRef = useRef<Float32Array | null>(null);
  const ambientFrameCountRef = useRef(0);
  const requestedFftSizeRef = useRef(requestedFftSize);
  requestedFftSizeRef.current = requestedFftSize;

  const [detectedPings, setDetectedPings] = useState<DetectedPing[]>([]);
  const [chartOverlays, setChartOverlays] = useState<PingCaptureOverlays | null>(
    null,
  );
  const [pingCaptureProgress, setPingCaptureProgress] =
    useState<PingCaptureProgress | null>(null);
  const chartOverlaysRef = useRef<PingCaptureOverlays | null>(null);
  /** When true, ignore stale detector snapshots until the next live capture. */
  const overlaysLockedRef = useRef(false);
  const pingDetectorRef = useRef<PingDetector | null>(null);
  const pingDetectionEnabledRef = useRef(pingDetectionEnabled);
  pingDetectionEnabledRef.current = pingDetectionEnabled;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    ambientProfileRef.current = ambientProfile;
  }, [ambientProfile]);

  useEffect(() => {
    subtractEnabledRef.current = subtractAmbientEnabled;
  }, [subtractAmbientEnabled]);

  // Keep ping detector range in sync with the visible window.
  useEffect(() => {
    if (
      pingDetectionMinHz === undefined ||
      pingDetectionMaxHz === undefined ||
      !Number.isFinite(pingDetectionMinHz) ||
      !Number.isFinite(pingDetectionMaxHz) ||
      pingDetectionMaxHz <= pingDetectionMinHz
    ) {
      return;
    }
    if (!pingDetectorRef.current) {
      pingDetectorRef.current = createPingDetector({
        minHz: pingDetectionMinHz,
        maxHz: pingDetectionMaxHz,
      });
    } else {
      pingDetectorRef.current.setConfig({
        minHz: pingDetectionMinHz,
        maxHz: pingDetectionMaxHz,
      });
    }
  }, [pingDetectionMinHz, pingDetectionMaxHz]);

  // Re-prime baseline whenever detection is toggled on, ambient changes, or FFT changes.
  // Do not clear chart overlays here — zoom/FFT tweaks should not wipe the last ping trace.
  useEffect(() => {
    pingDetectorRef.current?.reset();
  }, [pingDetectionEnabled, requestedFftSize, ambientProfile]);

  useEffect(() => {
    const analyser = analyserRef.current;
    const ctx = audioContextRef.current;
    if (!analyser || !ctx) {
      return;
    }
    if (analyser.fftSize === requestedFftSize) {
      return;
    }

    analyser.fftSize = requestedFftSize;
    floatBufferRef.current = new Float32Array(analyser.frequencyBinCount);
    liveValuesRef.current = new Float32Array(analyser.frequencyBinCount);

    const profile = ambientProfileRef.current;
    if (
      capturingAmbientRef.current ||
      (profile && !isAmbientCompatible(profile, ctx.sampleRate, requestedFftSize))
    ) {
      capturingAmbientRef.current = false;
      ambientSumRef.current = null;
      ambientFrameCountRef.current = 0;
      ambientProfileRef.current = null;
      setAmbientProfile(null);
      setState((prev) => ({ ...prev, isCapturingAmbient: false, ambientProgress: 0 }));
    }
  }, [requestedFftSize]);

  const stopAnimation = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const cleanupStream = useCallback(() => {
    startRequestRef.current = null;
    stopAnimation();
    capturingAmbientRef.current = false;
    streamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    recordingStartedAtRef.current = 0;
  }, [stopAnimation]);

  const closeAudioContext = useCallback(async () => {
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    analyserRef.current = null;
    if (ctx && ctx.state !== "closed") {
      await ctx.close();
    }
  }, []);

  const finishAmbientCapture = useCallback(() => {
    const analyser = analyserRef.current;
    const ctx = audioContextRef.current;
    const sum = ambientSumRef.current;
    const frames = ambientFrameCountRef.current;

    capturingAmbientRef.current = false;
    ambientSumRef.current = null;
    ambientFrameCountRef.current = 0;

    if (!mountedRef.current) {
      return;
    }

    if (!analyser || !ctx || !sum || frames === 0 || sum.length !== analyser.frequencyBinCount) {
      setState((prev) => ({
        ...prev,
        isCapturingAmbient: false,
        ambientProgress: 0,
        error: "Ambient capture failed — no audio frames collected.",
      }));
      return;
    }

    const profile = finalizeAmbientProfile(sum, frames, ctx.sampleRate, analyser.fftSize);
    setAmbientProfile(profile);
    setSubtractAmbientEnabled(true);
    setState((prev) => ({
      ...prev,
      isCapturingAmbient: false,
      ambientProgress: 1,
      error: null,
    }));
  }, []);

  const startLiveLoop = useCallback(() => {
    const analyser = analyserRef.current;
    const ctx = audioContextRef.current;
    if (!analyser || !ctx) {
      return;
    }

    if (!floatBufferRef.current || floatBufferRef.current.length !== analyser.frequencyBinCount) {
      floatBufferRef.current = new Float32Array(analyser.frequencyBinCount);
    }
    if (!liveValuesRef.current || liveValuesRef.current.length !== analyser.frequencyBinCount) {
      liveValuesRef.current = new Float32Array(analyser.frequencyBinCount);
    }

    lastLiveUiUpdateRef.current = 0;
    lastAmbientUiUpdateRef.current = 0;

    const tick = () => {
      if (!mountedRef.current || !analyserRef.current || !audioContextRef.current) {
        return;
      }

      const buffer = floatBufferRef.current!;
      const displayValues = liveValuesRef.current!;
      analyser.getFloatFrequencyData(buffer as Float32Array<ArrayBuffer>);

      const profile = ambientProfileRef.current;
      const subtract =
        subtractEnabledRef.current &&
        !capturingAmbientRef.current &&
        profile !== null &&
        isAmbientCompatible(profile, ctx.sampleRate, analyser.fftSize);

      if (subtract) {
        subtractAmbientInto(buffer, profile, displayValues);
      } else {
        displayValues.set(buffer);
      }

      const now = performance.now();

      if (capturingAmbientRef.current) {
        if (!ambientSumRef.current) {
          ambientSumRef.current = createAmbientAccumulator(buffer.length);
          ambientFrameCountRef.current = 0;
        }
        accumulateAmbientFrame(ambientSumRef.current, buffer);
        ambientFrameCountRef.current += 1;

        if (now - ambientCaptureStartRef.current >= AMBIENT_CAPTURE_MS) {
          finishAmbientCapture();
        } else if (now - lastAmbientUiUpdateRef.current >= AMBIENT_UI_INTERVAL_MS) {
          lastAmbientUiUpdateRef.current = now;
          const progress = Math.min(1, (now - ambientCaptureStartRef.current) / AMBIENT_CAPTURE_MS);
          if (mountedRef.current) {
            setState((prev) => ({ ...prev, ambientProgress: progress }));
          }
        }
      }

      if (
        pingDetectionEnabledRef.current &&
        !capturingAmbientRef.current &&
        pingDetectorRef.current
      ) {
        const detector = pingDetectorRef.current;
        const ping = detector.feed(
          displayValues,
          ctx.sampleRate,
          analyser.fftSize,
          now,
          subtract,
        );

        const maxHoldPreview = detector.getMaxHoldPreview();
        const accumPreview = detector.getAccumulatedPreview();
        const lastCapture = detector.getLastCaptureOverlays();

        if (mountedRef.current) {
          if (maxHoldPreview || accumPreview) {
            overlaysLockedRef.current = false;
            setChartOverlays((prev) => {
              const fallback = prev ?? chartOverlaysRef.current;
              const spectrum = maxHoldPreview
                ? cloneSpectrumData(maxHoldPreview)
                : fallback?.spectrum;
              if (!spectrum) {
                return prev;
              }
              const next: PingCaptureOverlays = {
                spectrum,
                accumulated: accumPreview
                  ? cloneSpectrumData(accumPreview)
                  : fallback?.accumulated ?? null,
              };
              chartOverlaysRef.current = next;
              return next;
            });
          } else if (lastCapture && !overlaysLockedRef.current) {
            setChartOverlays((prev) => {
              const fallback = prev ?? chartOverlaysRef.current;
              const next: PingCaptureOverlays = {
                spectrum: cloneSpectrumData(lastCapture.spectrum),
                accumulated: lastCapture.accumulated
                  ? cloneSpectrumData(lastCapture.accumulated)
                  : fallback?.accumulated ?? null,
              };
              chartOverlaysRef.current = next;
              return next;
            });
          }
        }

        if (ping && mountedRef.current) {
          overlaysLockedRef.current = false;
          const fallback = chartOverlaysRef.current;
          const overlays = mergeCaptureOverlays(
            ping.spectrum,
            ping.accumulatedSpectrum ?? lastCapture?.accumulated ?? undefined,
            fallback,
          );
          chartOverlaysRef.current = overlays;
          setChartOverlays(overlays);
          const storedAccumulated =
            overlays.accumulated ?? ping.accumulatedSpectrum ?? null;
          setDetectedPings((prev) => {
            if (isDuplicatePing(ping, prev)) {
              return prev;
            }
            const next = prev.length >= MAX_DETECTED_PINGS
              ? prev.slice(prev.length - MAX_DETECTED_PINGS + 1)
              : prev.slice();
            next.push({
              ...ping,
              spectrum: cloneSpectrumData(ping.spectrum),
              accumulatedSpectrum: storedAccumulated
                ? cloneSpectrumData(storedAccumulated)
                : null,
            });
            return next;
          });
        }

        if (mountedRef.current) {
          const captureProgress = detector.getCaptureProgress(now);
          setPingCaptureProgress(captureProgress);
        }
      } else if (mountedRef.current) {
        setPingCaptureProgress((prev) => (prev === null ? null : null));
      }

      if (now - lastLiveUiUpdateRef.current >= LIVE_UI_INTERVAL_MS) {
        lastLiveUiUpdateRef.current = now;
        if (mountedRef.current) {
          setState((prev) => ({
            ...prev,
            liveSpectrum: {
              values: new Float32Array(displayValues),
              sampleRate: ctx.sampleRate,
              fftSize: analyser.fftSize,
              ambientSubtracted: subtract,
            },
          }));
        }
      }

      if (
        recorderRef.current &&
        recordingStartedAtRef.current > 0 &&
        now - recordingStartedAtRef.current >= MAX_RECORDING_MS
      ) {
        setState((prev) => ({
          ...prev,
          error: "Recording stopped automatically after 60 seconds.",
        }));
        void stopRecordingRef.current();
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [finishAmbientCapture]);

  const stopRecordingRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const startListening = useCallback(async () => {
    if (!mountedRef.current || startRequestRef.current || streamRef.current) {
      return;
    }

    const request = Symbol("microphone request");
    startRequestRef.current = request;
    const isCurrentRequest = () =>
      mountedRef.current && startRequestRef.current === request;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let connected = false;
    setState((prev) => ({ ...prev, isStarting: true, error: null }));

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (!isCurrentRequest()) {
        return;
      }

      streamRef.current = stream;
      ctx = new AudioContext();
      audioContextRef.current = ctx;
      await ctx.resume();
      if (!isCurrentRequest()) {
        return;
      }

      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = LIVE_INPUT_GAIN;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = requestedFftSizeRef.current;
      analyser.smoothingTimeConstant = 0;
      analyser.minDecibels = -110;
      analyser.maxDecibels = -5;
      source.connect(gain);
      gain.connect(analyser);

      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (!mountedRef.current || streamRef.current !== stream) {
            return;
          }
          setState((prev) => ({
            ...prev,
            isStarting: false,
            isListening: false,
            isRecording: false,
            isCapturingAmbient: false,
            liveSpectrum: null,
            error: "Microphone disconnected or stopped by the system.",
          }));
          cleanupStream();
          void closeAudioContext();
        };
      });

      analyserRef.current = analyser;

      if (
        ambientProfile &&
        !isAmbientCompatible(ambientProfile, ctx.sampleRate, analyser.fftSize)
      ) {
        setAmbientProfile(null);
        ambientProfileRef.current = null;
      }

      pingDetectorRef.current?.reset();
      chartOverlaysRef.current = null;
      setChartOverlays(null);

      setState((prev) => ({
        ...prev,
        isListening: true,
        isRecording: false,
        isCapturingAmbient: false,
        ambientProgress: 0,
        recordingSpectrum: null,
        recordingBlob: null,
        error: null,
      }));

      startLiveLoop();
      connected = true;
    } catch (captureError) {
      if (isCurrentRequest()) {
        stopAnimation();
        setState((prev) => ({
          ...prev,
          isListening: false,
          error:
            captureError instanceof Error
              ? captureError.message
              : "Microphone access was denied or unavailable.",
        }));
      }
    } finally {
      if (startRequestRef.current === request) {
        startRequestRef.current = null;
        if (mountedRef.current) {
          setState((prev) => ({ ...prev, isStarting: false }));
        }
      }
      if (!connected) {
        // Dispose only this request's resources; a newer request may own refs.
        stream?.getTracks().forEach((track) => {
          track.onended = null;
          track.stop();
        });
        if (streamRef.current === stream) {
          streamRef.current = null;
        }
        if (audioContextRef.current === ctx) {
          audioContextRef.current = null;
          analyserRef.current = null;
        }
        if (ctx && ctx.state !== "closed") {
          await ctx.close();
        }
      }
    }
  }, [ambientProfile, cleanupStream, closeAudioContext, startLiveLoop, stopAnimation]);

  const stopListening = useCallback(async () => {
    capturingAmbientRef.current = false;
    pingDetectorRef.current?.reset();
    chartOverlaysRef.current = null;
    setChartOverlays(null);
    setPingCaptureProgress(null);
    cleanupStream();
    setState((prev) => ({
      ...prev,
      isStarting: false,
      isListening: false,
      isRecording: false,
      isCapturingAmbient: false,
      ambientProgress: 0,
      liveSpectrum: null,
    }));
    await closeAudioContext();
  }, [cleanupStream, closeAudioContext]);

  const startAmbientCapture = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser || !streamRef.current) {
      return;
    }

    ambientSumRef.current = createAmbientAccumulator(analyser.frequencyBinCount);
    ambientFrameCountRef.current = 0;
    capturingAmbientRef.current = true;
    ambientCaptureStartRef.current = performance.now();
    lastAmbientUiUpdateRef.current = 0;
    pingDetectorRef.current?.reset();
    chartOverlaysRef.current = null;
    setChartOverlays(null);

    setState((prev) => ({
      ...prev,
      isCapturingAmbient: true,
      ambientProgress: 0,
      error: null,
    }));
  }, []);

  const clearAmbientProfile = useCallback(() => {
    capturingAmbientRef.current = false;
    ambientSumRef.current = null;
    ambientFrameCountRef.current = 0;
    ambientProfileRef.current = null;
    setAmbientProfile(null);
    setState((prev) => ({
      ...prev,
      isCapturingAmbient: false,
      ambientProgress: 0,
    }));
  }, []);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || capturingAmbientRef.current) {
      return;
    }

    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    recordingStartedAtRef.current = performance.now();

    setState((prev) => ({
      ...prev,
      isRecording: true,
      recordingSpectrum: null,
      recordingBlob: null,
    }));
  }, []);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }

    recordingStartedAtRef.current = 0;
    setState((prev) => ({ ...prev, isRecording: false }));

    const blob = await new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || "audio/webm";
        resolve(new Blob(chunksRef.current, { type: mimeType }));
      };
      recorder.onerror = () => reject(new Error("Recording failed."));
      recorder.stop();
    });

    recorderRef.current = null;
    chunksRef.current = [];

    if (!mountedRef.current) {
      return;
    }

    try {
      const decodeCtx = new AudioContext();
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
      await decodeCtx.close();

      let recordingSpectrum = await computeSpectrumFromBuffer(audioBuffer);
      recordingSpectrum = applyAmbientToSpectrumData(
        recordingSpectrum,
        ambientProfileRef.current,
        subtractEnabledRef.current,
      );

      setState((prev) => ({
        ...prev,
        recordingSpectrum,
        recordingBlob: blob,
      }));
    } catch (decodeError) {
      setState((prev) => ({
        ...prev,
        error:
          decodeError instanceof Error
            ? decodeError.message
            : "Could not analyze the recording.",
        recordingBlob: blob,
      }));
    }
  }, []);

  stopRecordingRef.current = stopRecording;

  const clearRecording = useCallback(() => {
    setState((prev) => ({
      ...prev,
      recordingSpectrum: null,
      recordingBlob: null,
    }));
  }, []);

  const clearChartOverlays = useCallback(() => {
    overlaysLockedRef.current = true;
    chartOverlaysRef.current = null;
    setChartOverlays(null);
    setPingCaptureProgress(null);
    pingDetectorRef.current?.reset();
  }, []);

  const clearDetectedPings = useCallback(() => {
    setDetectedPings([]);
    clearChartOverlays();
  }, [clearChartOverlays]);

  const dismissDetectedPing = useCallback(
    (id: string) => {
      setDetectedPings((prev) => {
        const next = prev.filter((p) => p.id !== id);
        if (next.length === 0) {
          clearChartOverlays();
        }
        return next;
      });
    },
    [clearChartOverlays],
  );

  /**
   * Append a user-defined peak. If any pings already exist, the peak is added
   * to the most recent one; otherwise a fresh ping is created so the peak has
   * somewhere to live.
   */
  const addManualPeak = useCallback(
    (frequencyHz: number, kind: "long" | "short") => {
      if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) return;

      const sustainMs = kind === "long" ? 300 : 150;
      const sourceSpectrum =
        liveValuesRef.current && analyserRef.current && audioContextRef.current
          ? {
              values: new Float32Array(liveValuesRef.current),
              sampleRate: audioContextRef.current.sampleRate,
              fftSize: analyserRef.current.fftSize,
              ambientSubtracted:
                subtractEnabledRef.current &&
                ambientProfileRef.current !== null,
            }
          : null;

      // Best-effort magnitude estimate from the live spectrum, or a
      // sensible placeholder when there's no audio context yet.
      let magnitude = -30;
      if (sourceSpectrum) {
        const bin = Math.round(
          (frequencyHz * sourceSpectrum.fftSize) / sourceSpectrum.sampleRate,
        );
        if (bin >= 0 && bin < sourceSpectrum.values.length) {
          const v = sourceSpectrum.values[bin];
          if (Number.isFinite(v)) magnitude = v;
        }
      }

      const newPeak: ResonancePeak = {
        frequencyHz,
        magnitude,
        kind,
        sustainMs,
      };

      setDetectedPings((prev) => {
        if (prev.length === 0) {
          const fallbackSpectrum =
            sourceSpectrum ?? {
              values: new Float32Array(0),
              sampleRate: 48_000,
              fftSize: FFT_SIZE,
              ambientSubtracted: false,
            };
          const created: DetectedPing = {
            id: `ping-manual-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 7)}`,
            detectedAt: new Date().toISOString(),
            spectrum: fallbackSpectrum,
            peaks: [newPeak],
            ambientSubtracted: fallbackSpectrum.ambientSubtracted,
            triggerBandDb: 0,
            baselineBandDb: 0,
            topPeakSustainMs: sustainMs,
          };
          return [...prev, created];
        }

        const next = prev.slice();
        const lastIndex = next.length - 1;
        const last = next[lastIndex];
        const peaks = [...last.peaks, newPeak].sort(
          (a, b) => a.frequencyHz - b.frequencyHz,
        );
        next[lastIndex] = {
          ...last,
          peaks,
          topPeakSustainMs: Math.max(
            last.topPeakSustainMs ?? 0,
            sustainMs,
          ),
        };
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    return () => {
      cleanupStream();
      void closeAudioContext();
    };
  }, [cleanupStream, closeAudioContext]);

  return {
    ...state,
    ambientProfile,
    subtractAmbientEnabled,
    setSubtractAmbientEnabled,
    startListening,
    stopListening,
    startAmbientCapture,
    clearAmbientProfile,
    startRecording,
    stopRecording,
    clearRecording,
    detectedPings,
    chartOverlays,
    pingCaptureProgress,
    clearDetectedPings,
    dismissDetectedPing,
    addManualPeak,
  };
}
