import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, protocol, systemPreferences } from "electron";

import type { CoinCatalogApi } from "../src/types/catalog.js";
import type { ReferenceInput } from "../src/types/coinPing.js";
import { CoinPingDb } from "../src-electron/db/coinPingDb.js";
import { CatalogFiles } from "./catalogFiles.js";

const isMac = process.platform === "darwin";
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

let db: CoinPingDb;
let files: CatalogFiles;
let writingFiles = false;

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
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
  }

  return mainWindow;
}

function ensureWritable() {
  if (writingFiles) throw new Error("Wait for the current library operation to finish.");
}

async function writeFiles<T>(action: () => Promise<T>): Promise<T> {
  ensureWritable();
  writingFiles = true;
  try {
    return await action();
  } finally {
    writingFiles = false;
  }
}

async function ensureMicrophoneAccess(): Promise<boolean> {
  if (!isMac) return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "not-determined") return systemPreferences.askForMediaAccess("microphone");
  return status === "granted";
}

function registerIpcHandlers(): void {
  ipcMain.handle("microphone:request", ensureMicrophoneAccess);
  ipcMain.handle("references:list", () => db.listReferences());
  ipcMain.handle("references:create", (_event, input: ReferenceInput) => {
    ensureWritable();
    return db.createReference(input);
  });
  ipcMain.handle("references:delete", (_event, id: number) => {
    ensureWritable();
    db.deleteReference(id);
  });

  // Keep individual methods and validation in main; the renderer has no file
  // paths or generic access to IPC.
  function handle<K extends keyof CoinCatalogApi>(
    name: K,
    action: (...args: Parameters<CoinCatalogApi[K]>) => ReturnType<CoinCatalogApi[K]> | Awaited<ReturnType<CoinCatalogApi[K]>>,
    readOnly = false,
  ) {
    ipcMain.handle(`catalog:${name}`, (_event, ...args: Parameters<CoinCatalogApi[K]>) => {
      if (!readOnly) ensureWritable();
      return action(...args);
    });
  }

  handle("listCoins", () => db.listCoins(), true);
  handle("getCoin", (id) => db.getCoin(id), true);
  handle("createCoin", (input) => db.createCoin(input));
  handle("updateCoin", (id, input) => db.updateCoin(id, input));
  handle("archiveCoin", (id) => db.archiveCoin(id));
  handle("restoreCoin", (id) => db.restoreCoin(id));
  handle("createSpecification", (id, input) => db.createSpecification(id, input));
  handle("updateSpecification", (id, input) => db.updateSpecification(id, input));
  handle("deleteSpecification", (id) => db.deleteSpecification(id));
  handle("setPrimaryImage", (id) => db.setPrimaryImage(id));
  handle("deleteImage", (id) => writeFiles(() => files.removePhoto(db, id)));
  handle("linkReference", (id, coinId) => db.linkReference(id, coinId));
  handle("createSession", (id, input) => db.createSession(id, input));
  handle("updateSession", (id, input) => db.updateSession(id, input));
  handle("createMeasurement", (id, input) => db.createMeasurement(id, input));
  handle("createComparison", (id, input) => db.createComparison(id, input));
  handle("updateComparison", (id, input) => db.updateComparison(id, input));
  handle("saveSoundResult", (id, input) => db.saveSoundResult(id, input));

  handle("importImage", (input) => writeFiles(async () => {
    const selection = await dialog.showOpenDialog({
      title: "Choose a coin photo",
      properties: ["openFile"],
      filters: [{ name: "Coin photos", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return files.importPhoto(db, selection.filePaths[0], input);
  }));
  handle("exportBackup", () => writeFiles(async () => {
    const selection = await dialog.showOpenDialog({
      title: "Choose where to save the Coin Library backup",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return false;
    await files.exportBackup(db, selection.filePaths[0]);
    return true;
  }));
  handle("importBackup", () => writeFiles(async () => {
    const selection = await dialog.showOpenDialog({
      title: "Select a Coin Library backup folder",
      properties: ["openDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return false;
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: "Open this backup as your active coin library?",
      detail: "The app will open a copy of the backup. Your current library stays on disk.",
      buttons: ["Cancel", "Restore backup"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return false;
    const previous = db;
    db = await files.restoreBackup(selection.filePaths[0]);
    try {
      previous.checkpointAndClose("TRUNCATE");
    } catch (error) {
      console.error("Could not close the previous library:", error);
    }
    return true;
  }));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([
    { scheme: "coin-media", privileges: { standard: true, secure: true } },
  ]);

  app.whenReady().then(async () => {
    files = await CatalogFiles.open(app.getPath("userData"));
    db = new CoinPingDb(files.databasePath);
    protocol.handle("coin-media", (request) => files.servePhoto(db, request.url));
    registerIpcHandlers();
    createWindow();

    app.on("second-instance", () => {
      const window = BrowserWindow.getAllWindows()[0] ?? createWindow();
      if (window.isMinimized()) window.restore();
      if (isMac) app.focus({ steal: true });
      window.show();
      window.focus();
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error: unknown) => {
    dialog.showErrorBox("Could not open the coin library", error instanceof Error ? error.message : String(error));
    app.quit();
  });

  app.on("window-all-closed", () => {
    if (!isMac || devServerUrl) app.quit();
  });

  app.on("before-quit", () => {
    try {
      db?.checkpointAndClose("TRUNCATE");
    } catch (error) {
      console.error("Failed to checkpoint/close database on shutdown:", error);
    }
  });
}
