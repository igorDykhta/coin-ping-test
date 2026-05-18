/// <reference types="vite/client" />

import type { CoinPingApi } from "./types/coinPing";

declare global {
  interface Window {
    coinPingApi: CoinPingApi;
  }
}
