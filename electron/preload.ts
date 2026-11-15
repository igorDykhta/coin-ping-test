import { contextBridge, ipcRenderer } from "electron";

import type { CoinCatalogApi } from "../src/types/catalog.js";
import type { CoinPingApi, ReferenceInput } from "../src/types/coinPing.js";

const coinPingApi: CoinPingApi = {
  listReferences: () => ipcRenderer.invoke("references:list"),
  createReference: (input: ReferenceInput) => ipcRenderer.invoke("references:create", input),
  deleteReference: (id: number) => ipcRenderer.invoke("references:delete", id),
  requestMicrophoneAccess: () => ipcRenderer.invoke("microphone:request"),
};

function catalogMethod<K extends keyof CoinCatalogApi>(name: K) {
  return (...args: Parameters<CoinCatalogApi[K]>) =>
    ipcRenderer.invoke(`catalog:${name}`, ...args);
}

const coinCatalogApi: CoinCatalogApi = {
  listCoins: catalogMethod("listCoins"),
  getCoin: catalogMethod("getCoin"),
  createCoin: catalogMethod("createCoin"),
  updateCoin: catalogMethod("updateCoin"),
  archiveCoin: catalogMethod("archiveCoin"),
  restoreCoin: catalogMethod("restoreCoin"),
  createSpecification: catalogMethod("createSpecification"),
  updateSpecification: catalogMethod("updateSpecification"),
  deleteSpecification: catalogMethod("deleteSpecification"),
  importImage: catalogMethod("importImage"),
  setPrimaryImage: catalogMethod("setPrimaryImage"),
  deleteImage: catalogMethod("deleteImage"),
  linkReference: catalogMethod("linkReference"),
  createSession: catalogMethod("createSession"),
  updateSession: catalogMethod("updateSession"),
  createMeasurement: catalogMethod("createMeasurement"),
  createComparison: catalogMethod("createComparison"),
  updateComparison: catalogMethod("updateComparison"),
  saveSoundResult: catalogMethod("saveSoundResult"),
  exportBackup: catalogMethod("exportBackup"),
  importBackup: catalogMethod("importBackup"),
};

contextBridge.exposeInMainWorld("coinPingApi", coinPingApi);
contextBridge.exposeInMainWorld("coinCatalogApi", coinCatalogApi);
