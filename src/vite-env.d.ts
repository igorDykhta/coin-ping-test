/// <reference types="vite/client" />

import type { CoinCatalogApi } from "./types/catalog";
import type { CoinPingApi } from "./types/coinPing";

declare global {
  interface Window {
    coinPingApi: CoinPingApi;
    coinCatalogApi: CoinCatalogApi;
  }
}
