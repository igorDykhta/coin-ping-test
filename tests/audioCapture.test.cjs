const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAudioHarness, createLoader, deferred } = require("./helpers.cjs");

function assertReleased(h) {
  assert.ok(h.streams.every((s) => s.getTracks().every((t) => t.stopped)));
  assert.ok(h.contexts.every((ctx) => ctx.state === "closed"));
  assert.equal(h.frames.size, 0);
}

test("manual peaks carry no measured level or sustain even with live spectrum data", async () => {
  const h = createAudioHarness();
  h.api.addManualPeak(5500, "long");
  let [ping] = h.render().detectedPings;
  assert.deepEqual(ping.peaks, [{ source: "manual", frequencyHz: 5500, kind: "long" }]);
  assert.equal(ping.topPeakSustainMs, undefined);
  assert.equal(ping.triggerBandDb, undefined);
  assert.equal(ping.baselineBandDb, undefined);

  h.api.clearDetectedPings();
  await h.api.startListening();
  h.frame(80).addManualPeak(6200, "short");
  [ping] = h.render().detectedPings;
  assert.ok(ping.spectrum.values.length > 0);
  assert.deepEqual(ping.peaks, [{ source: "manual", frequencyHz: 6200, kind: "short" }]);
  assert.equal(ping.topPeakSustainMs, undefined);
  await h.api.stopListening();
  assertReleased(h);
});

test("overlapping starts create one session and Stop releases it", async () => {
  const h = createAudioHarness();
  await Promise.all([h.api.startListening(), h.api.startListening()]);
  h.render();
  assert.equal(h.requests.length, 1);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.frames.size, 1);
  assert.equal(h.api.isListening, true);
  await h.api.stopListening();
  h.render();
  assert.equal(h.api.isListening, false);
  assertReleased(h);
});

for (const action of ["stop", "unmount"]) {
  test(`${action} disposes a late microphone permission response`, async () => {
    const permission = deferred();
    const h = createAudioHarness({ media: () => permission.promise });
    const pending = h.api.startListening();
    h.render();
    assert.equal(h.api.isStarting, true);
    if (action === "stop") await h.api.stopListening();
    else h.unmount();
    permission.resolve(h.makeStream());
    await pending;
    assert.equal(h.contexts.length, 0);
    assertReleased(h);
  });

  test(`${action} releases resources while AudioContext.resume is pending`, async () => {
    const resumed = deferred();
    const h = createAudioHarness({ resume: () => resumed.promise });
    const pending = h.api.startListening();
    await Promise.resolve();
    assert.equal(h.contexts.length, 1);
    if (action === "stop") await h.api.stopListening();
    else h.unmount();
    assertReleased(h);
    resumed.resolve();
    await pending;
    assertReleased(h);
  });
}

test("a canceled request cannot replace or stop a newer session", async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const h = createAudioHarness({ media: () => (++count === 1 ? first.promise : second.promise) });
  const pendingFirst = h.api.startListening();
  await h.api.stopListening();
  const pendingSecond = h.api.startListening();
  const secondStream = h.makeStream();
  second.resolve(secondStream);
  await pendingSecond;
  const firstStream = h.makeStream();
  first.resolve(firstStream);
  await pendingFirst;
  h.render();
  assert.equal(h.api.isListening, true);
  assert.equal(secondStream.getTracks()[0].stopped, false);
  assert.equal(firstStream.getTracks()[0].stopped, true);
  assert.equal(h.frames.size, 1);
  await h.api.stopListening();
  assertReleased(h);
});

test("resume failures release acquired resources and allow retry", async () => {
  let attempt = 0;
  const h = createAudioHarness({ resume: () => { if (++attempt === 1) throw new Error("Resume failed"); } });
  await h.api.startListening();
  h.render();
  assert.equal(h.api.error, "Resume failed");
  assert.equal(h.api.isStarting, false);
  assertReleased(h);
  await h.api.startListening();
  h.render();
  assert.equal(h.api.isListening, true);
  assert.equal(h.api.error, null);
  await h.api.stopListening();
  assertReleased(h);
});

test("FFT changes cancel initial ambient capture and allow a fresh calibration", async () => {
  const h = createAudioHarness();
  await h.api.startListening();
  h.render();
  h.api.startAmbientCapture();
  h.frame(1010);
  h.render({ fftSize: 32768 });
  assert.equal(h.api.isCapturingAmbient, false);
  assert.equal(h.api.ambientProfile, null);
  h.frame(5010);
  assert.equal(h.api.ambientProfile, null);
  h.api.startAmbientCapture();
  h.frame(6010);
  h.frame(10010);
  assert.equal(h.api.ambientProfile.fftSize, 32768);
  assert.equal(h.api.ambientProfile.values.length, 16384);
  await h.api.stopListening();
  assertReleased(h);
});

test("ambient compatibility rejects mismatched buffer dimensions", () => {
  const { isAmbientCompatible } = createLoader()("src/lib/ambient.ts");
  const profile = { values: new Float32Array(4096), sampleRate: 48000, fftSize: 32768 };
  assert.equal(isAmbientCompatible(profile, 48000, 32768), false);
  assert.equal(isAmbientCompatible({ ...profile, values: new Float32Array(16384) }, 48000, 32768), true);
});

test("switching away after Stop recording preserves earlier chunks and the terminal chunk", async () => {
  let recorder;
  let decoded;
  let stopCalls = 0;
  class RecordingStub {
    state = "inactive";
    constructor() { recorder = this; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; stopCalls++; }
  }
  const h = createAudioHarness({
    MediaRecorder: RecordingStub,
    decodeAudioData(buffer) {
      decoded = Buffer.from(buffer).toString();
      return { duration: 0, sampleRate: 48000 };
    },
  });
  await h.api.startListening();
  h.render().startRecording();
  recorder.ondataavailable({ data: new Blob(["first"]) });

  const pending = h.render().stopRecording();
  const alsoPending = h.render().stopRecording();
  assert.equal(h.render().isRecording, false);
  assert.equal(h.api.isFinalizingRecording, true);
  // Leaving the workspace releases the live stream before the terminal events.
  await h.api.stopListening();
  assertReleased(h);

  recorder.ondataavailable({ data: new Blob(["-terminal"]) });
  recorder.onstop();
  await new Promise(setImmediate);
  h.frame(100);
  await Promise.all([pending, alsoPending]);
  assert.equal(stopCalls, 1);
  assert.equal(decoded, "first-terminal");
  assert.equal(await h.render().recordingBlob.text(), "first-terminal");
  assert.equal(h.api.isFinalizingRecording, false);
  assertReleased(h);
});

test("a finished take survives restarting the microphone until explicitly cleared", async () => {
  let recorder;
  class RecordingStub {
    state = "inactive";
    constructor() { recorder = this; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
  }
  const h = createAudioHarness({
    MediaRecorder: RecordingStub,
    decodeAudioData: () => ({ duration: 0, sampleRate: 48000 }),
  });
  await h.api.startListening();
  h.render().startRecording();
  h.render().startAmbientCapture();
  h.render();
  assert.equal(h.api.isCapturingAmbient, false, "recording should reserve the microphone from ambient calibration");

  recorder.ondataavailable({ data: new Blob(["take"]) });
  const pending = h.api.stopRecording();
  recorder.onstop();
  await new Promise(setImmediate);
  h.frame(100);
  await pending;
  const { recordingIdentity, recordingSpectrum } = h.render();
  assert.ok(recordingIdentity);
  assert.ok(recordingSpectrum);

  await h.api.stopListening();
  await h.render().startListening();
  h.render();
  assert.equal(h.api.isListening, true);
  assert.equal(h.api.recordingIdentity, recordingIdentity);
  assert.equal(h.api.recordingSpectrum, recordingSpectrum);

  h.api.clearRecording();
  assert.equal(h.render().recordingIdentity, null);
  assert.equal(h.api.recordingSpectrum, null);
  await h.api.stopListening();
  assertReleased(h);
});
