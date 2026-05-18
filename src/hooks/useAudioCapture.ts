import { useCallback, useEffect, useRef, useState } from "react";

import {
  computeSpectrumFromBuffer,
  FFT_SIZE,
  LIVE_INPUT_GAIN,
  type SpectrumData,
} from "../lib/spectrum";

type AudioCaptureState = {
  isListening: boolean;
  isRecording: boolean;
  liveSpectrum: SpectrumData | null;
  recordingSpectrum: SpectrumData | null;
  recordingBlob: Blob | null;
  error: string | null;
};

const initialState: AudioCaptureState = {
  isListening: false,
  isRecording: false,
  liveSpectrum: null,
  recordingSpectrum: null,
  recordingBlob: null,
  error: null,
};

export function useAudioCapture() {
  const [state, setState] = useState<AudioCaptureState>(initialState);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const floatBufferRef = useRef<Float32Array | null>(null);

  const stopAnimation = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const cleanupStream = useCallback(() => {
    stopAnimation();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, [stopAnimation]);

  const closeAudioContext = useCallback(async () => {
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    analyserRef.current = null;
    if (ctx && ctx.state !== "closed") {
      await ctx.close();
    }
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

    const tick = () => {
      const buffer = floatBufferRef.current!;
      analyser.getFloatFrequencyData(buffer);
      setState((prev) => ({
        ...prev,
        liveSpectrum: {
          values: new Float32Array(buffer),
          sampleRate: ctx.sampleRate,
          fftSize: analyser.fftSize,
        },
      }));
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const startListening = useCallback(async () => {
    setState((prev) => ({ ...prev, error: null }));

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      const ctx = new AudioContext();
      await ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = LIVE_INPUT_GAIN;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.35;
      analyser.minDecibels = -110;
      analyser.maxDecibels = -5;
      source.connect(gain);
      gain.connect(analyser);

      streamRef.current = stream;
      audioContextRef.current = ctx;
      analyserRef.current = analyser;

      setState((prev) => ({
        ...prev,
        isListening: true,
        isRecording: false,
        recordingSpectrum: null,
        recordingBlob: null,
        error: null,
      }));

      startLiveLoop();
    } catch (captureError) {
      cleanupStream();
      await closeAudioContext();
      setState((prev) => ({
        ...prev,
        error:
          captureError instanceof Error
            ? captureError.message
            : "Microphone access was denied or unavailable.",
      }));
    }
  }, [cleanupStream, closeAudioContext, startLiveLoop]);

  const stopListening = useCallback(async () => {
    cleanupStream();
    await closeAudioContext();
    setState((prev) => ({
      ...prev,
      isListening: false,
      isRecording: false,
      liveSpectrum: null,
    }));
  }, [cleanupStream, closeAudioContext]);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) {
      return;
    }

    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    recorder.start();
    recorderRef.current = recorder;

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

    try {
      const decodeCtx = new AudioContext();
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
      await decodeCtx.close();

      const recordingSpectrum = await computeSpectrumFromBuffer(audioBuffer);

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

  const clearRecording = useCallback(() => {
    setState((prev) => ({
      ...prev,
      recordingSpectrum: null,
      recordingBlob: null,
    }));
  }, []);

  useEffect(() => {
    return () => {
      cleanupStream();
      void closeAudioContext();
    };
  }, [cleanupStream, closeAudioContext]);

  return {
    ...state,
    startListening,
    stopListening,
    startRecording,
    stopRecording,
    clearRecording,
  };
}
