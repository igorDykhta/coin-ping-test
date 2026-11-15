const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createLoader } = require("./helpers.cjs");

function runElectronStub(result, completed = false) {
  const process = { env: {} };
  let profile;
  const load = createLoader({
    electron: "electron-stub",
    "node:child_process": {
      spawnSync(_executable, _args, { env }) {
        profile = env.COIN_TEST_PROFILE;
        if (completed) fs.writeFileSync(path.join(profile, "workflows-completed"), "");
        return result;
      },
    },
  }, { process, __dirname: path.join(__dirname, "electron") });

  try {
    load("tests/electron/run.cjs");
    return process.exitCode;
  } finally {
    assert.equal(fs.existsSync(profile), false, "The temporary profile was cleaned up");
  }
}

test("Electron workflow checks fail when the app exits cleanly before completing them", () => {
  assert.throws(() => runElectronStub({ status: 0 }), /before completing the workflow checks/);
});

test("Electron workflow checks require both a completion marker and a successful exit", () => {
  assert.equal(runElectronStub({ status: 0 }, true), 0);
  assert.equal(runElectronStub({ status: 2 }, true), 2);
  assert.equal(runElectronStub({ status: null, signal: "SIGTERM" }), 1);
});
