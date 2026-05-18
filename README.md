# Coin Ping Analyzer

Electron desktop app for recording coin ping sounds, visualizing microphone frequencies, matching resonances against known references, and storing correct recordings for future comparison.

## Tech stack

- Electron + React + TypeScript (same layout as [finance-insights](../finance-insights))
- Vite for the renderer
- SQLite (`node:sqlite` in the main process) for reference metadata
- `@sqlrooms/ui` for UI components

## Run

Use Node.js 20+ (Vite 8 / Tailwind need it). With [nvm](https://github.com/nvm-sh/nvm):

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

## Database

SQLite file (macOS):

`~/Library/Application Support/coin-ping-test/coin-ping-test.sqlite`

## Planned features

- Record coin ping from microphone
- Real-time frequency spectrum graph
- Compare detected resonances to saved references
- Save a recording as a correct reference for future matching
