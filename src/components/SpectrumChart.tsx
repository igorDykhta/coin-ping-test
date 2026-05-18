import { useEffect, useRef } from "react";

import {
  ANALYZER_MAX_DB,
  ANALYZER_MIN_DB,
  binToFrequencyHz,
  CHART_BAR_SLOT_PX,
  CHART_MAX_BARS,
  CHART_MIN_BARS,
  FREQUENCY_GRID_HZ,
  maxDisplayBin,
  MIN_DISPLAY_HZ,
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
  logFrequency?: boolean;
  peakHold?: boolean;
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
  maxHz: number,
  logFrequency: boolean,
): number {
  if (barCount <= 1) {
    return 0;
  }
  if (logFrequency) {
    const logMin = Math.log10(MIN_DISPLAY_HZ);
    const logMax = Math.log10(maxHz);
    const t = (Math.log10(hz) - logMin) / (logMax - logMin);
    return Math.round(Math.max(0, Math.min(1, t)) * (barCount - 1));
  }
  return Math.round((hz / maxHz) * (barCount - 1));
}

export function SpectrumChart({
  spectrum,
  peaks = [],
  title,
  minDb = ANALYZER_MIN_DB,
  maxDb = ANALYZER_MAX_DB,
  displayBoostDb = 0,
  logFrequency = true,
  peakHold = false,
}: SpectrumChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const peakHoldRef = useRef<Float32Array | null>(null);
  const peakHoldEnabledRef = useRef(peakHold);

  peakHoldEnabledRef.current = peakHold;

  useEffect(() => {
    if (!peakHold) {
      peakHoldRef.current = null;
    }
  }, [peakHold]);

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
      const maxHz = binToFrequencyHz(lastBin, sampleRate, fftSize);
      const binHz = sampleRate / fftSize;

      const barCount = Math.max(
        CHART_MIN_BARS,
        Math.min(CHART_MAX_BARS, Math.floor(plotW / CHART_BAR_SLOT_PX)),
      );

      const barValues = logFrequency
        ? sampleLogFrequencySpectrum(values, sampleRate, fftSize, barCount)
        : (() => {
            const linear = new Float32Array(barCount);
            for (let i = 0; i < barCount; i += 1) {
              const bin = (i / Math.max(1, barCount - 1)) * lastBin;
              linear[i] = sampleSpectrumAtBin(values, bin);
            }
            return linear;
          })();

      const slotW = plotW / barCount;
      const barW = Math.max(1, slotW * 0.88);

      const freqTicks = FREQUENCY_GRID_HZ.filter(
        (hz) => hz >= MIN_DISPLAY_HZ && hz <= maxHz,
      );

      ctx.strokeStyle = "hsl(222 27% 18%)";
      ctx.lineWidth = 1;
      for (const hz of freqTicks) {
        const barIndex = frequencyToBarIndex(hz, barCount, maxHz, logFrequency);
        const x = plotLeft + barIndex * slotW + slotW / 2;
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
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

      ctx.fillStyle = "hsl(215 20% 60%)";
      ctx.textAlign = "center";
      ctx.font = "10px JetBrains Mono, ui-monospace, monospace";
      ctx.textBaseline = "alphabetic";

      let lastLabelX = -Infinity;
      for (const hz of freqTicks) {
        const barIndex = frequencyToBarIndex(hz, barCount, maxHz, logFrequency);
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
      ctx.fillText(
        `${Math.round(binHz)} Hz/bin · ${barCount} bars`,
        plotLeft,
        height - 8,
      );

      for (const peak of peaks) {
        const barIndex = frequencyToBarIndex(
          peak.frequencyHz,
          barCount,
          maxHz,
          logFrequency,
        );
        if (barIndex < 0 || barIndex >= barCount) {
          continue;
        }
        const x = plotLeft + barIndex * slotW + slotW / 2;
        ctx.strokeStyle = "hsl(142 70% 55%)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
      }

      if (title) {
        ctx.fillStyle = "hsl(210 40% 96%)";
        ctx.font = "600 12px Inter, sans-serif";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(title, plotLeft + 6, padding.top + 14);
      }
    };

    draw();

    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [spectrum, peaks, title, minDb, maxDb, displayBoostDb, logFrequency, peakHold]);

  return (
    <div ref={containerRef} className="h-full min-h-[320px] w-full">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
