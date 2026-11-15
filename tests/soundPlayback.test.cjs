const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHookRunner, createLoader, deferred } = require("./helpers.cjs");

function playbackHarness(getSoundAudio) {
  const runner = createHookRunner();
  const blobs = [];
  const revoked = [];
  const { SoundResultPlayback } = createLoader({
    react: runner.react, "@sqlrooms/ui": { Button: "Button" },
  }, {
    window: { coinCatalogApi: { getSoundAudio } },
    URL: {
      createObjectURL(blob) { blobs.push(blob); return `blob:recording-${blobs.length}`; },
      revokeObjectURL(url) { revoked.push(url); },
    },
  })("src/components/SoundResultPlayback.tsx");
  return { ...runner, blobs, revoked, render: () => runner.render(() => SoundResultPlayback({ resultId: 42 })) };
}

const clip = { mimeType: "audio/webm", bytes: new Uint8Array([1, 2, 3]) };

test("saved audio loads on demand, exposes playback controls, and releases its URL", async () => {
  const retrieval = deferred();
  const harness = playbackHarness((id) => {
    assert.equal(id, 42);
    return retrieval.promise;
  });
  assert.equal(harness.render().props.role, "status");
  retrieval.resolve(clip);
  await retrieval.promise;
  const player = harness.render();
  assert.equal(player.type, "audio");
  assert.equal(player.props.controls, true);
  assert.equal(player.props.src, "blob:recording-1");
  assert.equal(harness.blobs[0].type, clip.mimeType);
  assert.deepEqual(new Uint8Array(await harness.blobs[0].arrayBuffer()), clip.bytes);
  harness.unmount();
  assert.deepEqual(harness.revoked, [player.props.src]);
});

test("a recording returned after the user closes the result never allocates a playback URL", async () => {
  const retrieval = deferred();
  const harness = playbackHarness(() => retrieval.promise);
  harness.render();
  harness.unmount();
  retrieval.resolve(clip);
  await retrieval.promise;
  assert.equal(harness.blobs.length, 0);
});

test("playback can retry after a load failure", async () => {
  let attempts = 0;
  const harness = playbackHarness(async () => {
    if (++attempts === 1) throw new Error("The recording could not be read.");
    return clip;
  });
  harness.render();
  await new Promise(setImmediate);
  const [error, retry] = harness.render().props.children;
  assert.equal(error.props.role, "alert");
  assert.match(error.props.children, /could not be read/);
  retry.props.onClick();
  assert.equal(harness.render().props.role, "status");
  await new Promise(setImmediate);
  assert.equal(harness.render().type, "audio");
});
