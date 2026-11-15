const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createAudioHarness, createLoader, deferred } = require("./helpers.cjs");

function assertReleased(h) {
  assert.ok(h.streams.every((s) => s.getTracks().every((t) => t.stopped)));
  assert.ok(h.contexts.every((ctx) => ctx.state === "closed"));
  assert.equal(h.frames.size, 0);
}

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
