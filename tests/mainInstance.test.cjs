const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createLoader } = require("./helpers.cjs");

function start({ ownsLock }) {
  const calls = [];
  const windows = [];
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock() { calls.push("lock"); return ownsLock; },
    quit() { calls.push("quit"); },
    whenReady() { calls.push("ready"); return Promise.resolve(); },
    getPath() { return "/profile"; },
    focus() { calls.push("activate app"); },
  });
  const load = createLoader({
    electron: {
      app,
      protocol: { registerSchemesAsPrivileged() { calls.push("register scheme"); }, handle() {} },
      ipcMain: { handle() {} },
      dialog: { showErrorBox(_title, message) { calls.push(`error: ${message}`); } },
      BrowserWindow: class {
        static getAllWindows() { return windows; }
        constructor() { windows.push(this); calls.push("create window"); }
        loadFile() {}
        loadURL() {}
        isMinimized() { return !!this.minimized; }
        restore() { this.minimized = false; calls.push("restore window"); }
        show() { calls.push("show window"); }
        focus() { calls.push("focus window"); }
      },
    },
    "./catalogFiles.js": { CatalogFiles: {
      async open() { calls.push("read active library"); return { databasePath: "/profile/catalog.sqlite" }; },
    } },
    "../src-electron/db/coinPingDb.js": { CoinPingDb: class {
      constructor() { calls.push("open library"); }
    } },
  }, { __dirname: "/coin-ping/electron" });
  load("electron/main.ts");
  return { app, calls, windows };
}

test("a secondary process quits before resolving the active library", () => {
  const { calls } = start({ ownsLock: false });
  assert.deepEqual(calls, ["lock", "quit"]);
});

test("relaunching restores the primary window without reopening the library", async () => {
  const { app, calls, windows } = start({ ownsLock: true });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["lock", "register scheme", "ready", "read active library", "open library", "create window"]);

  windows[0].minimized = true;
  app.emit("second-instance");
  assert.equal(windows.length, 1);
  assert.equal(windows[0].minimized, false);
  assert.deepEqual(calls.slice(-2), ["show window", "focus window"]);

  windows.length = 0;
  app.emit("second-instance");
  assert.equal(windows.length, 1);
  assert.deepEqual(calls.slice(-2), ["show window", "focus window"]);
  assert.equal(calls.filter((call) => call === "open library").length, 1);
});
