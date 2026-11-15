const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "coin-ping-ui-"));
try {
  const env = { ...process.env, COIN_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  const result = spawnSync(require("electron"), [path.join(__dirname, "workflows.cjs")], {
    cwd: path.resolve(__dirname, "../.."),
    env,
    stdio: "inherit",
    timeout: 110_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
