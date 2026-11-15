const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createLoader } = require("./helpers.cjs");
const { createPingDetector } = createLoader()("src/lib/pingDetector.ts");

function capture(durationMs, { ambient = false, magnitude = -20 } = {}) {
  const detector = createPingDetector({ minHz: 4000, maxHz: 8000 });
  const values = new Float32Array(4096).fill(-100);
  const pings = [];
  let preview;
  for (let now = 10; now <= 6500; now += 10) {
    values[900] = now >= 1010 && now <= 1010 + durationMs ? magnitude : -100;
    const ping = detector.feed(values, 48000, 8192, now, ambient);
    if (now === 5500) preview = detector.getMaxHoldPreview();
    if (ping) pings.push(ping);
  }
  return { pings, preview };
}

for (const ambient of [false, true]) {
  for (const durationMs of [100, 150, 190, 200, 220, 300, 500]) {
    test(`${durationMs} ms resonance retains magnitude and sustain (ambient=${ambient})`, () => {
      const { pings, preview } = capture(durationMs, { ambient });
      assert.equal(pings.length, 1);
      const [peak] = pings[0].peaks;
      assert.equal(peak.frequencyHz, 900 * 48000 / 8192);
      assert.equal(peak.magnitude, -20);
      assert.equal(peak.sustainMs, durationMs);
      assert.equal(peak.kind, durationMs < 200 ? "short" : "long");
      assert.equal(pings[0].spectrum.values[900], -20);
      assert.ok(preview.values[900] < -50, "preview should still decay");
    });
  }
}

test("quiet tail cannot promote a brief transient into a sustained ping", () => {
  assert.equal(capture(50).pings.length, 0);
});

test("a valid quiet resonance survives even without qualifying accumulated power", () => {
  const { pings } = capture(300, { magnitude: -50 });
  assert.equal(pings.length, 1);
  assert.equal(pings[0].peaks[0].magnitude, -50);
  assert.equal(pings[0].peaks[0].sustainMs, 300);
});
