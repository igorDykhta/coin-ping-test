const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const { root } = require("./helpers.cjs");

test("production scripts and styles resolve from a file:// Electron page", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "coin-ping-build-test-"));
  try {
    execFileSync(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--outDir", outDir], {
      cwd: root, stdio: "pipe",
    });
    const entry = path.join(outDir, "index.html");
    const html = fs.readFileSync(entry, "utf8");
    const assets = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)].map((m) => m[1]);
    assert.ok(assets.length >= 2);
    for (const asset of assets) {
      const resolved = new URL(asset, pathToFileURL(entry));
      assert.ok(resolved.href.startsWith(pathToFileURL(outDir + path.sep).href), resolved.href);
      assert.ok(fs.existsSync(resolved), `Missing built asset: ${resolved.href}`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
