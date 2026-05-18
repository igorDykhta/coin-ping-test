import { contextBridge, ipcRenderer } from "electron";

import type { CoinPingApi, ReferenceInput } from "../src/types/coinPing.js";

const coinPingApi: CoinPingApi = {
  listReferences: () => ipcRenderer.invoke("references:list"),
  createReference: (input: ReferenceInput) => ipcRenderer.invoke("references:create", input),
  deleteReference: (id: number) => ipcRenderer.invoke("references:delete", id),
};

contextBridge.exposeInMainWorld("coinPingApi", coinPingApi);
