const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHookRunner, createLoader } = require("./helpers.cjs");

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== "object") return undefined;
  return predicate(node) ? node : find(node.props?.children, predicate);
}

function panelHarness(initial = {}) {
  let runner = createHookRunner();
  const react = Object.fromEntries(Object.keys(runner.react).map((name) => [
    name, (...args) => runner.react[name](...args),
  ]));
  const ui = Object.fromEntries([
    "Button", "Card", "CardContent", "CardHeader", "CardTitle", "ContextMenu", "ContextMenuContent",
    "ContextMenuItem", "ContextMenuSeparator", "ContextMenuTrigger", "Input",
  ].map((name) => [name, name]));
  const peaks = [];
  const range = { minHz: 500, maxHz: 24_000, setRange() {}, resetRange() {} };
  const clearRecording = () => {
    model.recordingSpectrum = null;
    model.recordingBlob = null;
    model.recordingIdentity = null;
  };
  const model = {
    isListening: false,
    detectedPings: [],
    clearRecording,
    addManualPeak: (...peak) => peaks.push(peak),
    ...initial,
  };
  let detection;
  const props = { onDetectedPingsChange(state) { detection = state; } };
  const load = createLoader({
    react,
    "@sqlrooms/ui": { ...ui, cn: (...args) => args.filter(Boolean).join(" ") },
    "../hooks/useAudioCapture": { useAudioCapture: () => model },
    "../hooks/useFrequencyRange": { useFrequencyRange: () => range },
    "./AmbientControls": { AmbientControls: "AmbientControls" },
    "./FrequencyRangeControls": { FrequencyRangeControls: "FrequencyRangeControls" },
    "./SpectrumChart": { SpectrumChart: "SpectrumChart" },
  });
  const { LiveSpectrumPanel } = load("src/components/LiveSpectrumPanel.tsx");
  const render = () => runner.render(() => LiveSpectrumPanel(props));
  return {
    render, model, range, peaks,
    get detection() { return detection; },
    button(label) {
      return find(render(), (node) => node.type === "Button" && node.props.children === label);
    },
    enterPeak() {
      const manual = find(render(), (node) => node.type?.name === "ManualPeakEntry");
      runner = createHookRunner();
      return () => runner.render(() => manual.type(manual.props));
    },
  };
}

test("adjusting the displayed frequency range retains the completed recording identity", () => {
  const values = new Float32Array(4096).fill(-110);
  values[1024] = -30;
  const recordingIdentity = { id: "recording-1", capturedAt: "2026-01-01T10:00:00.000Z" };
  const app = panelHarness({
    recordingSpectrum: { values, sampleRate: 48_000, fftSize: 8192, ambientSubtracted: true },
    recordingBlob: new Blob(["coin ping"]),
    recordingIdentity,
  });

  const chart = find(app.render(), (node) => node.type === "SpectrumChart");
  assert.equal(chart.props.title, "Recording (ambient subtracted)");
  assert.equal(chart.props.maxDb, 40);
  assert.equal(app.detection.manualRecording.peaks[0].frequencyHz, 6000);
  app.range.minHz = 2000;
  app.render();
  assert.equal(app.detection.manualRecording.id, recordingIdentity.id);
  assert.equal(app.detection.manualRecording.detectedAt, recordingIdentity.capturedAt);
  assert.equal(app.detection.manualRecording.peaks[0].frequencyHz, 6000);

  // The playback view can be cleared even when listening has already stopped.
  assert.ok(app.button("Start listening"));
  app.button("Clear recording").props.onClick();
  app.render();
  assert.equal(app.detection.manualRecording, undefined);
  assert.equal(app.button("Clear recording"), undefined);
});

test("manual peak entry validates the frequency and accepts keyboard submission", () => {
  const app = panelHarness();
  const entry = app.enterPeak();
  const input = () => find(entry(), (node) => node.type === "Input");
  const submit = () => find(entry(), (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  input().props.onChange({ currentTarget: { value: "50000" } });
  submit();
  assert.deepEqual(app.peaks, []);
  assert.match(find(entry(), (node) => node.props.role === "alert").props.children, /1 to 24000 Hz/);

  input().props.onChange({ currentTarget: { value: "4750.5" } });
  find(entry(), (node) => node.type === "select").props.onChange({ currentTarget: { value: "short" } });
  submit();
  assert.deepEqual(app.peaks, [[4750.5, "short"]]);
  assert.equal(input().props.value, "");
  assert.match(find(entry(), (node) => node.props.role === "status").props.children, /Added 4750.5 Hz/);
});

test("the live ping status follows calibration and the visible detection band", () => {
  const app = panelHarness({ isListening: true });
  app.render();
  assert.equal(app.detection.enabled, true);
  app.model.isCapturingAmbient = true;
  app.render();
  assert.equal(app.detection.enabled, false);
  assert.match(app.detection.inactiveMessage, /paused during ambient calibration/);
  app.model.isCapturingAmbient = false;
  app.range.maxHz = 3500;
  app.render();
  assert.equal(app.detection.enabled, false);
  assert.match(app.detection.inactiveMessage, /adjust the frequency range/i);
  app.range.maxHz = 8000;
  app.render();
  assert.equal(app.detection.enabled, true);
  assert.equal(app.detection.inactiveMessage, undefined);
});
