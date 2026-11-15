# Coin Ping Analyzer

Electron desktop app for cataloging coin variants, comparing their sound and photos, and recording measurements. The catalog stays on your computer.

## Tech stack

- Electron + React + TypeScript (same layout as [finance-insights](../finance-insights))
- Vite for the renderer
- SQLite (`node:sqlite` in the main process) for the catalog, resonance references, and test sessions
- `@sqlrooms/ui` for UI components

## Run

Use Node.js 20.19+ or 22.12+ from a Vite-supported release line. With [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm use    # reads .nvmrc → Node 20
yarn install
yarn dev
```

## Build

```bash
yarn build
```

Produces:

- `dist/` — renderer bundle
- `dist-electron/` — Electron main/preload

## Check changes

```bash
yarn test
yarn tsc --noEmit -p tsconfig.json
yarn tsc --noEmit -p tsconfig.electron.json
yarn test:electron
```

The regression suite covers detector timing, microphone lifecycle, catalog migration, measurements, photo alignment, reference saving, and production asset resolution. The SQLite tests require a shell Node version with `node:sqlite`.

`yarn test:electron` builds and launches the desktop app. It drives catalog forms, photo alignment, recording and saving a sound result, and backup and restore. It requires a graphical desktop and uses a temporary profile, synthetic audio, and test file picker responses. Set `COIN_TEST_SCREENSHOTS` to a directory to retain screenshots for inspection.

## Workspaces

- **Catalog** has searchable coin cards and editable details. Add obverse, reverse, and optional edge reference photos, as well as weight, density, and GoldScreenSensor specifications. Start a specimen test for each physical coin. Its checklist tracks the three readings, both face comparisons, and sound results. Edit readings in the specimen's history to correct their values or reference ranges.
- **Sound analysis** compares live or manually recorded pings against a selected coin or the entire reference library. Select a specimen session to save test results. Takes captured with **Record ping** include playable audio in the specimen's history. Save reference peaks separately at the coin variant level, or link existing peaks from **Unassigned references**.
- **Image comparison** aligns a local JPEG or PNG with a reference for the same coin face. Position, rotate, and scale each layer, then save the comparison to reopen it from the coin's test history.

## Storage and backups

On macOS the initial SQLite file is `~/Library/Application Support/coin-ping-test/coin-ping-test.sqlite`. The database includes saved audio, and imported photos are copied into the app library. Use **Back up library** in the Catalog to export the database and photos together. **Restore backup** opens a copy of that folder as the active library and retains the previous library on disk.
