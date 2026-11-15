import { useEffect, useRef } from "react";

import {
  ANALYZER_MAX_DB,
  ANALYZER_MIN_DB,
  binToFrequencyHz,
  CHART_BAR_SLOT_PX,
  CHART_MAX_BARS,
  CHART_MIN_BARS,
  buildFrequencyGrid,
  clampFrequencyRange,
  DEFAULT_MAX_DISPLAY_HZ,
  DEFAULT_MIN_DISPLAY_HZ,
  maxDisplayBin,
  sampleLogFrequencySpectrum,
  sampleSpectrumAtBin,
  type SpectrumData,
} from "../lib/spectrum";
import type { ResonancePeak } from "../types/coinPing";

type SpectrumChartProps = {
  spectrum: SpectrumData | null;
  peaks?: ResonancePeak[];
  title?: string;
  minDb?: number;
  maxDb?: number;
  displayBoostDb?: number;
  minHz?: number;
  maxHz?: number;
  logFrequency?: boolean;
  peakHold?: boolean;
  /**
   * Optional secondary spectrum drawn as a line on top of the bars. Used to
   * overlay a captured "max-hold" snapshot (e.g. the latest detected ping)
   * over the still-updating live bars.
   */
  overlaySpectrum?: SpectrumData | null;
  /**
   * Optional time-averaged power spectrum (post-transient integral) drawn as a
   * red line on top of the bars alongside the max-hold overlay.
   */
  accumulatedOverlaySpectrum?: SpectrumData | null;
  /**
   * Frequencies (Hz) of a saved reference recording to highlight as blue
   * tolerance bands underneath the bars. Each entry produces a 10 px wide
   * (±5 px) semi-transparent rectangle plus a thin center line.
   *
   * If `color` is provided, an additional colored circle is drawn at the top
   * of the chart so users can visually distinguish multiple references that
   * are simultaneously overlaid. Circles at the same x position stack
   * vertically.
   */
  referenceLines?: readonly { frequencyHz: number; color?: string }[];
  /**
   * Enables mouse-wheel zoom anchored under the cursor. The callback receives
   * the proposed (un-clamped) new frequency range; the parent is responsible
   * for clamping / applying the change.
   */
  onRangeChange?: (minHz: number, maxHz: number) => void;
  /**
   * Right-click handler. Receives the frequency under the cursor (Hz) and the
   * native event so the parent can position a context menu. The native menu
   * is suppressed automatically.
   */
  onContextMenuFrequency?: (frequencyHz: number, event: MouseEvent) => void;
  /**
   * Active auto-detect capture window. Draws a horizontal progress bar that
   * shrinks as the capture window elapses.
   */
  captureWindow?: { startedAtMs: number; totalMs: number } | null;
  /** When true, show a full-width amber bar (manual recording). */
  isRecordingActive?: boolean;
};

function captureRemainingFraction(
  window: { startedAtMs: number; totalMs: number },
  nowMs = performance.now(),
): number {
  const totalMs = Math.max(1, window.totalMs);
  const elapsedMs = Math.max(0, Math.min(totalMs, nowMs - window.startedAtMs));
  return Math.max(0, 1 - elapsedMs / totalMs);
}

type PlotBounds = {
  plotLeft: number;
  plotW: number;
  plotMinHz: number;
  plotMaxHz: number;
  logFrequency: boolean;
};

const Y_GRID_LINES = 10;
const X_LABEL_SKIP_THRESHOLD = 10;

function formatDbLabel(db: number): string {
  const rounded = Math.round(db);
  if (rounded === 0) {
    return "0 dB";
  }
  return `${rounded} dB`;
}

function formatHzLabel(hz: number): string {
  if (hz >= 1000) {
    return hz % 1000 === 0 ? `${hz / 1000}k` : `${(hz / 1000).toFixed(1)}k`;
  }
  return `${Math.round(hz)}`;
}

function barColorForLevel(t: number): string {
  if (t < 0.45) {
    return `hsl(38 55% ${32 + t * 40}%)`;
  }
  if (t < 0.75) {
    return `hsl(38 88% ${48 + (t - 0.45) * 80}%)`;
  }
  return `hsl(48 96% ${72 + (t - 0.75) * 80}%)`;
}

function frequencyToBarIndex(
  hz: number,
  barCount: number,
  minHz: number,
  maxHz: number,
  logFrequency: boolean,
): number {
  if (barCount <= 1) {
    return 0;
  }
  if (logFrequency) {
    const logMin = Math.log10(minHz);
    const logMax = Math.log10(maxHz);
    const t = (Math.log10(hz) - logMin) / (logMax - logMin);
    return Math.round(Math.max(0, Math.min(1, t)) * (barCount - 1));
  }
  const t = (hz - minHz) / (maxHz - minHz);
  return Math.round(Math.max(0, Math.min(1, t)) * (barCount - 1));
}

function sampleOverlayForBars(
  overlay: SpectrumData,
  barCount: number,
  plotMinHz: number,
  axisMaxHz: number,
  logFrequency: boolean,
  preserveGaps = false,
): Float32Array {
  if (logFrequency) {
    return sampleLogFrequencySpectrum(
      overlay.values,
      overlay.sampleRate,
      overlay.fftSize,
      barCount,
      plotMinHz,
      axisMaxHz,
      preserveGaps,
    );
  }
  const lastOvBin = maxDisplayBin(overlay.sampleRate, overlay.fftSize);
  const out = new Float32Array(barCount);
  const span = axisMaxHz - plotMinHz;
  for (let i = 0; i < barCount; i += 1) {
    const t = barCount <= 1 ? 0 : i / (barCount - 1);
    const hz = plotMinHz + t * span;
    const bin = (hz * overlay.fftSize) / overlay.sampleRate;
    out[i] =
      bin >= lastOvBin
        ? overlay.values[lastOvBin]
        : sampleSpectrumAtBin(overlay.values, bin, preserveGaps);
  }
  return out;
}

function strokeSpectrumLine(
  ctx: CanvasRenderingContext2D,
  values: Float32Array,
  plotLeft: number,
  slotW: number,
  barCount: number,
  mapHeight: (db: number) => number,
  plotBottom: number,
  strokeStyle: string,
  dbOffset = 0,
  lineWidth = 1.8,
) {
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = strokeStyle;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < barCount; i += 1) {
    const db = values[i];
    if (!Number.isFinite(db)) continue;
    const h = mapHeight(db + dbOffset);
    const x = plotLeft + i * slotW + slotW / 2;
    const y = plotBottom - h;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  if (started) ctx.stroke();
}

export function SpectrumChart({
  spectrum,
  peaks = [],
  title,
  minDb = ANALYZER_MIN_DB,
  maxDb = ANALYZER_MAX_DB,
  displayBoostDb = 0,
  minHz = DEFAULT_MIN_DISPLAY_HZ,
  maxHz = DEFAULT_MAX_DISPLAY_HZ,
  logFrequency = true,
  peakHold = false,
  overlaySpectrum = null,
  accumulatedOverlaySpectrum = null,
  referenceLines,
  onRangeChange,
  onContextMenuFrequency,
  captureWindow = null,
  isRecordingActive = false,
}: SpectrumChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const peakHoldRef = useRef<Float32Array | null>(null);
  const peakHoldEnabledRef = useRef(peakHold);
  const plotBoundsRef = useRef<PlotBounds | null>(null);
  const onRangeChangeRef = useRef(onRangeChange);
  const onContextMenuFrequencyRef = useRef(onContextMenuFrequency);
  const drawRef = useRef<(() => void) | null>(null);
  const captureWindowRef = useRef(captureWindow);
  const isRecordingActiveRef = useRef(isRecordingActive);

  peakHoldEnabledRef.current = peakHold;
  onRangeChangeRef.current = onRangeChange;
  onContextMenuFrequencyRef.current = onContextMenuFrequency;
  captureWindowRef.current = captureWindow;
  isRecordingActiveRef.current = isRecordingActive;

  useEffect(() => {
    if (!peakHold) {
      peakHoldRef.current = null;
    }
  }, [peakHold]);

  // Bar indices are tied to the current range; invalidate peak-hold on zoom.
  useEffect(() => {
    peakHoldRef.current = null;
  }, [minHz, maxHz]);

  // Smooth capture sweep at display refresh rate (independent of spectrum UI throttle).
  useEffect(() => {
    if (!captureWindow && !isRecordingActive) {
      return;
    }
    let rafId = 0;
    const loop = () => {
      drawRef.current?.();
      if (captureWindowRef.current || isRecordingActiveRef.current) {
        rafId = requestAnimationFrame(loop);
      }
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [captureWindow, isRecordingActive]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      const handler = onRangeChangeRef.current;
      const bounds = plotBoundsRef.current;
      if (!handler || !bounds) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const relX = mouseX - bounds.plotLeft;
      if (relX < 0 || relX > bounds.plotW) return;

      event.preventDefault();

      const t = bounds.plotW <= 0 ? 0 : relX / bounds.plotW;

      // Smooth, magnitude-aware zoom factor (trackpads send small deltas,
      // clicky mice send ~100). intensity caps at 0.5 (50% zoom per event).
      const intensity = Math.min(0.5, Math.abs(event.deltaY) / 500);
      if (intensity === 0) return;
      const factor = event.deltaY > 0 ? 1 + intensity : 1 / (1 + intensity);

      let newMin: number;
      let newMax: number;
      if (bounds.logFrequency) {
        const logMin = Math.log10(bounds.plotMinHz);
        const logMax = Math.log10(bounds.plotMaxHz);
        const logF = logMin + t * (logMax - logMin);
        const newLogMin = logF - (logF - logMin) * factor;
        const newLogMax = logF + (logMax - logF) * factor;
        newMin = 10 ** newLogMin;
        newMax = 10 ** newLogMax;
      } else {
        const freqF = bounds.plotMinHz + t * (bounds.plotMaxHz - bounds.plotMinHz);
        newMin = freqF - (freqF - bounds.plotMinHz) * factor;
        newMax = freqF + (bounds.plotMaxHz - freqF) * factor;
      }
      handler(newMin, newMax);
    };

    const handleContextMenu = (event: MouseEvent) => {
      const handler = onContextMenuFrequencyRef.current;
      const bounds = plotBoundsRef.current;
      if (!handler || !bounds) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const relX = mouseX - bounds.plotLeft;
      if (relX < 0 || relX > bounds.plotW) return;

      // NOTE: do NOT call event.preventDefault() here. We rely on the parent's
      // Radix ContextMenuTrigger to handle suppression of the native browser
      // menu *and* open its own menu; Radix's `composeEventHandlers` skips
      // its handler when `event.defaultPrevented` is already true.
      const t = bounds.plotW <= 0 ? 0 : relX / bounds.plotW;
      let freq: number;
      if (bounds.logFrequency) {
        const logMin = Math.log10(bounds.plotMinHz);
        const logMax = Math.log10(bounds.plotMaxHz);
        freq = 10 ** (logMin + t * (logMax - logMin));
      } else {
        freq = bounds.plotMinHz + t * (bounds.plotMaxHz - bounds.plotMinHz);
      }
      handler(freq, event);
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("contextmenu", handleContextMenu);
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {
      return;
    }

    const draw = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const padding = { top: 20, right: 10, bottom: 36 };
      const plotH = height - padding.top - padding.bottom;
      const plotBottom = padding.top + plotH;

      const yMin = minDb;
      const yMax = maxDb;
      const dbSpan = yMax - yMin;

      const axisFont = "10px JetBrains Mono, ui-monospace, monospace";
      ctx.font = axisFont;
      const yTickCount = Y_GRID_LINES;
      const tickLabels = Array.from({ length: yTickCount + 1 }, (_, i) =>
        formatDbLabel(yMax - (dbSpan * i) / yTickCount),
      );
      const maxLabelWidth = Math.max(
        ...tickLabels.map((label) => ctx.measureText(label).width),
        ctx.measureText("-90 dB").width,
      );
      const plotLeft = Math.ceil(maxLabelWidth) + 14;
      const plotW = width - plotLeft - padding.right;

      const mapHeight = (db: number) => {
        const boosted = db + displayBoostDb;
        const clamped = Math.max(yMin, Math.min(yMax, boosted));
        const normalized = (clamped - yMin) / dbSpan;
        return Math.max(0, normalized * plotH);
      };

      ctx.fillStyle = "hsl(222 47% 9%)";
      ctx.fillRect(plotLeft, padding.top, plotW, plotH);

      ctx.strokeStyle = "hsl(222 27% 20%)";
      ctx.lineWidth = 1;
      ctx.fillStyle = "hsl(215 20% 55%)";
      ctx.font = axisFont;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      for (let i = 0; i <= yTickCount; i += 1) {
        const y = padding.top + (plotH * i) / yTickCount;
        ctx.beginPath();
        ctx.moveTo(plotLeft, y);
        ctx.lineTo(plotLeft + plotW, y);
        ctx.stroke();
        if (i % 2 === 0 || i === yTickCount) {
          ctx.fillText(tickLabels[i], 6, y);
        }
      }

      ctx.save();
      ctx.translate(Math.max(12, plotLeft * 0.35), padding.top + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "hsl(215 20% 50%)";
      ctx.font = "11px Inter, sans-serif";
      ctx.fillText("Level (dB)", 0, 0);
      ctx.restore();

      if (!spectrum) {
        ctx.fillStyle = "hsl(215 20% 50%)";
        ctx.textAlign = "center";
        ctx.font = "13px Inter, sans-serif";
        ctx.fillText("No spectrum data", width / 2, height / 2);
        return;
      }

      const { values, sampleRate, fftSize } = spectrum;
      const lastBin = maxDisplayBin(sampleRate, fftSize);
      const dataMaxHz = binToFrequencyHz(lastBin, sampleRate, fftSize);
      const { minHz: plotMinHz, maxHz: plotMaxHz } = clampFrequencyRange(
        minHz,
        maxHz,
        sampleRate,
      );
      const axisMaxHz = Math.min(plotMaxHz, dataMaxHz);
      const binHz = sampleRate / fftSize;
      plotBoundsRef.current = {
        plotLeft,
        plotW,
        plotMinHz,
        plotMaxHz: axisMaxHz,
        logFrequency,
      };

      const barCount = Math.max(
        CHART_MIN_BARS,
        Math.min(CHART_MAX_BARS, Math.floor(plotW / CHART_BAR_SLOT_PX)),
      );

      const barValues = logFrequency
        ? sampleLogFrequencySpectrum(
            values,
            sampleRate,
            fftSize,
            barCount,
            plotMinHz,
            axisMaxHz,
          )
        : (() => {
            const linear = new Float32Array(barCount);
            const span = axisMaxHz - plotMinHz;
            for (let i = 0; i < barCount; i += 1) {
              const t = barCount <= 1 ? 0 : i / (barCount - 1);
              const hz = plotMinHz + t * span;
              const bin = (hz * fftSize) / sampleRate;
              linear[i] =
                bin >= lastBin ? values[lastBin] : sampleSpectrumAtBin(values, bin);
            }
            return linear;
          })();

      const slotW = plotW / barCount;
      const barW = Math.max(1, slotW * 0.88);

      const freqTicks = buildFrequencyGrid(plotMinHz, axisMaxHz);

      ctx.strokeStyle = "hsl(222 27% 18%)";
      ctx.lineWidth = 1;
      for (const hz of freqTicks) {
        const barIndex = frequencyToBarIndex(hz, barCount, plotMinHz, axisMaxHz, logFrequency);
        const x = plotLeft + barIndex * slotW + slotW / 2;
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
      }

      // Reference-recording overlay: blue ±5 px tolerance bands + center
      // lines drawn underneath the bars so peaks and bars remain readable.
      if (referenceLines && referenceLines.length > 0) {
        const halfWidthPx = 5;
        ctx.fillStyle = "hsla(210, 95%, 60%, 0.18)";
        for (const ref of referenceLines) {
          if (
            !Number.isFinite(ref.frequencyHz) ||
            ref.frequencyHz < plotMinHz ||
            ref.frequencyHz > axisMaxHz
          ) {
            continue;
          }
          const barIndex = frequencyToBarIndex(
            ref.frequencyHz,
            barCount,
            plotMinHz,
            axisMaxHz,
            logFrequency,
          );
          if (barIndex < 0 || barIndex >= barCount) continue;
          const x = plotLeft + barIndex * slotW + slotW / 2;
          ctx.fillRect(x - halfWidthPx, padding.top, halfWidthPx * 2, plotH);
        }
        ctx.strokeStyle = "hsla(210, 100%, 70%, 0.85)";
        ctx.lineWidth = 1;
        for (const ref of referenceLines) {
          if (
            !Number.isFinite(ref.frequencyHz) ||
            ref.frequencyHz < plotMinHz ||
            ref.frequencyHz > axisMaxHz
          ) {
            continue;
          }
          const barIndex = frequencyToBarIndex(
            ref.frequencyHz,
            barCount,
            plotMinHz,
            axisMaxHz,
            logFrequency,
          );
          if (barIndex < 0 || barIndex >= barCount) continue;
          const x = plotLeft + barIndex * slotW + slotW / 2;
          ctx.beginPath();
          ctx.moveTo(x, padding.top);
          ctx.lineTo(x, plotBottom);
          ctx.stroke();
        }

        // Colored marker circles at the top of the plot — one per reference
        // line that supplied a color. Multiple circles at the same x stack
        // vertically so all selected presets remain visible.
        const circleRadius = 4;
        const circleSpacing = circleRadius * 2 + 2;
        const circleStartY = padding.top + circleRadius + 1;
        const stacks = new Map<number, string[]>();
        for (const ref of referenceLines) {
          if (!ref.color) continue;
          if (
            !Number.isFinite(ref.frequencyHz) ||
            ref.frequencyHz < plotMinHz ||
            ref.frequencyHz > axisMaxHz
          ) {
            continue;
          }
          const barIndex = frequencyToBarIndex(
            ref.frequencyHz,
            barCount,
            plotMinHz,
            axisMaxHz,
            logFrequency,
          );
          if (barIndex < 0 || barIndex >= barCount) continue;
          const x = Math.round(plotLeft + barIndex * slotW + slotW / 2);
          const list = stacks.get(x);
          if (list) {
            list.push(ref.color);
          } else {
            stacks.set(x, [ref.color]);
          }
        }
        for (const [x, colors] of stacks) {
          for (let i = 0; i < colors.length; i += 1) {
            const cy = circleStartY + i * circleSpacing;
            ctx.beginPath();
            ctx.arc(x, cy, circleRadius, 0, Math.PI * 2);
            ctx.fillStyle = colors[i];
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(15, 23, 42, 0.85)";
            ctx.stroke();
          }
        }
      }

      if (peakHoldEnabledRef.current) {
        if (!peakHoldRef.current || peakHoldRef.current.length !== barCount) {
          peakHoldRef.current = new Float32Array(barCount).fill(yMin);
        }
        const held = peakHoldRef.current;
        for (let i = 0; i < barCount; i += 1) {
          if (barValues[i] > held[i]) {
            held[i] = barValues[i];
          } else {
            held[i] -= 0.25;
            if (held[i] < yMin) {
              held[i] = yMin;
            }
          }
        }
      }

      for (let i = 0; i < barCount; i += 1) {
        const db = barValues[i];
        const barH = mapHeight(db);
        if (barH < 0.5) {
          continue;
        }
        const x = plotLeft + i * slotW + (slotW - barW) / 2;
        const y = plotBottom - barH;
        const level = (db + displayBoostDb - yMin) / dbSpan;
        ctx.fillStyle = barColorForLevel(level);
        ctx.fillRect(x, y, barW, barH);
      }

      if (peakHoldRef.current) {
        ctx.fillStyle = "hsla(48, 100%, 88%, 0.85)";
        for (let i = 0; i < barCount; i += 1) {
          const peakH = mapHeight(peakHoldRef.current[i]);
          if (peakH < 1) {
            continue;
          }
          const x = plotLeft + i * slotW + (slotW - barW) / 2;
          ctx.fillRect(x, plotBottom - peakH - 1, barW, 1.5);
        }
      }

      // Overlay: max-hold (green) and accumulated power (red) from the latest
      // detected ping, drawn as line traces on top of the live bars.
      const drawLineOverlay = (
        overlay: SpectrumData,
        strokeStyle: string,
        options?: {
          dbOffset?: number;
          lineWidth?: number;
          preserveGaps?: boolean;
        },
      ) => {
        const overlayValues = sampleOverlayForBars(
          overlay,
          barCount,
          plotMinHz,
          axisMaxHz,
          logFrequency,
          options?.preserveGaps ?? false,
        );
        strokeSpectrumLine(
          ctx,
          overlayValues,
          plotLeft,
          slotW,
          barCount,
          mapHeight,
          plotBottom,
          strokeStyle,
          options?.dbOffset ?? 0,
          options?.lineWidth ?? 1.8,
        );
      };

      if (overlaySpectrum) {
        drawLineOverlay(overlaySpectrum, "hsla(142, 85%, 60%, 0.95)");
      }
      if (accumulatedOverlaySpectrum) {
        drawLineOverlay(
          accumulatedOverlaySpectrum,
          "hsla(0, 90%, 62%, 0.98)",
          { lineWidth: 2.2 },
        );
      }

      ctx.fillStyle = "hsl(215 20% 60%)";
      ctx.textAlign = "center";
      ctx.font = "10px JetBrains Mono, ui-monospace, monospace";
      ctx.textBaseline = "alphabetic";

      let lastLabelX = -Infinity;
      for (const hz of freqTicks) {
        const barIndex = frequencyToBarIndex(hz, barCount, plotMinHz, axisMaxHz, logFrequency);
        const x = plotLeft + barIndex * slotW + slotW / 2;
        if (x - lastLabelX < X_LABEL_SKIP_THRESHOLD) {
          continue;
        }
        ctx.fillText(formatHzLabel(hz), x, height - 8);
        lastLabelX = x;
      }

      ctx.textAlign = "left";
      ctx.fillStyle = "hsl(215 20% 45%)";
      ctx.font = "9px JetBrains Mono, ui-monospace, monospace";
      const viewSpanHz = axisMaxHz - plotMinHz;
      const hzPerBar = viewSpanHz / Math.max(1, barCount);
      const fftBinsInView = Math.max(1, Math.ceil(viewSpanHz / binHz));
      ctx.fillText(
        `${barCount} bars · ${fftBinsInView} FFT bins · ${binHz.toFixed(1)} Hz/bin · ~${hzPerBar.toFixed(1)} Hz/bar`,
        plotLeft,
        height - 8,
      );

      const longLineColor = "hsl(142 70% 55%)";
      const shortLineColor = "hsl(38 90% 60%)";
      const longLabelBg = "hsla(142, 70%, 25%, 0.85)";
      const shortLabelBg = "hsla(38, 75%, 25%, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.font = "10px JetBrains Mono, ui-monospace, monospace";

      // Lines run from the top of the plot to its vertical midpoint only,
      // so the bottom half of the chart (where most peaks reach) stays clear.
      const peakLineBottomY = padding.top + plotH / 2;
      const peakHits: {
        x: number;
        hz: number;
        isShort: boolean;
      }[] = [];
      for (const peak of peaks) {
        if (peak.frequencyHz < plotMinHz || peak.frequencyHz > axisMaxHz) {
          continue;
        }
        const barIndex = frequencyToBarIndex(
          peak.frequencyHz,
          barCount,
          plotMinHz,
          axisMaxHz,
          logFrequency,
        );
        if (barIndex < 0 || barIndex >= barCount) {
          continue;
        }
        const x = plotLeft + barIndex * slotW + slotW / 2;
        const isShort = peak.kind === "short";
        ctx.strokeStyle = isShort ? shortLineColor : longLineColor;
        ctx.setLineDash(isShort ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, peakLineBottomY);
        ctx.stroke();
        peakHits.push({ x, hz: peak.frequencyHz, isShort });
      }
      ctx.setLineDash([]);

      // Hz labels at the top of each peak line, with vertical stacking when
      // labels overlap horizontally.
      if (peakHits.length > 0) {
        const labelPaddingX = 4;
        const labelH = 14;
        const labelGap = 2;
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        const placed: { x: number; row: number; w: number }[] = [];
        for (const { x, hz, isShort } of peakHits) {
          const text = `${Math.round(hz)} Hz`;
          const textW = ctx.measureText(text).width;
          const w = textW + labelPaddingX * 2;
          let row = 0;
          while (
            placed.some(
              (p) =>
                p.row === row &&
                Math.abs(p.x - x) < (p.w + w) / 2 + 2,
            )
          ) {
            row += 1;
          }
          placed.push({ x, row, w });
          const labelTop = padding.top + 2 + row * (labelH + labelGap);
          const labelLeft = Math.max(plotLeft, Math.min(plotLeft + plotW - w, x - w / 2));
          ctx.fillStyle = isShort ? shortLabelBg : longLabelBg;
          ctx.fillRect(labelLeft, labelTop, w, labelH);
          ctx.fillStyle = isShort ? "hsl(40 95% 90%)" : "hsl(150 90% 92%)";
          ctx.fillText(text, labelLeft + w / 2, labelTop + labelH / 2);
        }
      }

      if (title) {
        ctx.fillStyle = "hsl(210 40% 96%)";
        ctx.font = "600 12px Inter, sans-serif";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(title, plotLeft + 6, padding.top + 14);
      }

      const activeCaptureWindow = captureWindowRef.current;
      const captureRemaining =
        activeCaptureWindow != null
          ? captureRemainingFraction(activeCaptureWindow)
          : null;

      if (captureRemaining != null && captureRemaining > 0) {
        const barH = 3;
        const barY = padding.top + 4;
        ctx.fillStyle = "hsla(142, 85%, 45%, 0.28)";
        ctx.fillRect(plotLeft, barY, plotW, barH);
        ctx.fillStyle = "hsl(142 92% 58%)";
        ctx.fillRect(plotLeft, barY, plotW * captureRemaining, barH);
      } else if (isRecordingActiveRef.current) {
        const progressBarH = 4;
        const progressY = padding.top + 4;
        ctx.fillStyle = "hsla(38, 90%, 45%, 0.28)";
        ctx.fillRect(plotLeft, progressY, plotW, progressBarH);
        ctx.fillStyle = "hsl(38 95% 55%)";
        ctx.fillRect(plotLeft, progressY, plotW, progressBarH);
      }
    };

    drawRef.current = draw;
    draw();

    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (drawRef.current === draw) {
        drawRef.current = null;
      }
    };
  }, [spectrum, peaks, title, minDb, maxDb, displayBoostDb, minHz, maxHz, logFrequency, peakHold, overlaySpectrum, accumulatedOverlaySpectrum, referenceLines, captureWindow, isRecordingActive]);

  return (
    <div ref={containerRef} className="h-full min-h-[320px] w-full">
      <canvas
        ref={canvasRef}
        className={`block h-full w-full${onRangeChange ? " cursor-crosshair" : ""}`}
        title={onRangeChange ? "Scroll to zoom (anchored at cursor)" : undefined}
      />
    </div>
  );
}
