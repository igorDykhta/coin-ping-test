import path from "node:path";
import { app, BrowserWindow, ipcMain, systemPreferences } from "electron";

import type { ReferenceInput } from "../src/types/coinPing.js";
import { CoinPingDb, ValidationError } from "../src-electron/db/coinPingDb.js";

const isMac = process.platform === "darwin";
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

let db: CoinPingDb;

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
  }

  return mainWindow;
}

function registerIpcHandlers(): void {
  ipcMain.handle("references:list", async () => db.listReferences());
  ipcMain.handle("references:create", async (_event, input: ReferenceInput) =>
    db.createReference(input),
  );
  ipcMain.handle("references:delete", async (_event, id: number) => {
    db.deleteReference(id);
  });
}

async function ensureMicrophoneAccess(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "not-determined") {
    await systemPreferences.askForMediaAccess("microphone");
  }
}

app.whenReady().then(async () => {
  await ensureMicrophoneAccess();

  const dbPath = path.join(app.getPath("userData"), "coin-ping-test.sqlite");
  console.log("[coin-ping-test] Database file:", dbPath);
  db = new CoinPingDb(dbPath);
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (!isMac || devServerUrl) {
    app.quit();
  }
});

app.on("before-quit", () => {
  try {
    db?.checkpointAndClose("TRUNCATE");
  } catch (error) {
    console.error("Failed to checkpoint/close database on shutdown:", error);
  }
});

process.on("uncaughtException", (error: Error) => {
  if (error instanceof ValidationError) {
    console.error(`Validation error: ${error.message}`);
    return;
  }

  console.error("Unhandled process error:", error);
});
