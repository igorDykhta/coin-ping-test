# Coin Ping Analyzer: AI Agent Guide

Repo-specific guidance for developing and debugging this Electron application. Read the relevant source files before changing behavior; constants and contracts below describe the current implementation and may evolve.

## Project context

Coin Ping Analyzer catalogs coin variants and compares candidate measurements, photos, and resonances against their references. SQLite stores catalog metadata and test history. Electron manages local photo files.

The stack is React 19, TypeScript 6 with strict checking, Vite 8, Electron 41, Tailwind CSS 4, and `@sqlrooms/ui`. Use `package.json` and `yarn.lock` for dependency requirements. Regression tests use Node's built-in test runner. There is no backend HTTP service, lint script, CI workflow, or installer packaging script in this checkout.

Before editing, inspect `git status --short`, `git diff`, and `git diff --cached`; preserve existing staged and unstaged work. Edit source files rather than generated `dist/`, `dist-electron/`, or `node_modules/` content.

## Find the right code

| Area | Entry points and responsibilities |
| --- | --- |
| App composition | `src/main.tsx`: StrictMode, theme, error boundary. `src/App.tsx`: workspace navigation, selected coin, and test-session context. |
| Catalog | `src/components/CoinCatalog.tsx` and `src/components/CoinDetails.tsx`: cards, edit forms, photos, specifications, and history. |
| Analysis workspaces | `src/components/SoundWorkspace.tsx`: analyzer, reference association, and matching scope. `src/components/ImageComparison.tsx`: independent layer alignment and saved comparisons. |
| Audio lifecycle | `src/hooks/useAudioCapture.ts`: microphone stream, AudioContext, analyser, recorder, animation loop, ambient capture, detection, and retained overlays. |
| Analysis orchestration | `src/components/LiveSpectrumPanel.tsx`: visible range, FFT selection, detection band, recording/live view, and manual-peak context menu. |
| Canvas rendering | `src/components/SpectrumChart.tsx`: bars, captured spectra, reference markers, peak labels, wheel zoom, and capture progress. |
| Frequency math | `src/lib/spectrum.ts`: FFT sizing, Hz/bin conversion, range clamping, spectrum sampling, buffer analysis, and local-maximum peak extraction. |
| Ping detection | `src/lib/pingDetector.ts`: baseline tracking, capture/refractory state machine, sustain classification, power integration, ranking, and duplicate detection. |
| Ambient calibration | `src/lib/ambient.ts` and `src/components/AmbientControls.tsx`: mean-power profile, compatibility, subtraction, and controls. |
| Reference matching | `src/lib/coinMatcher.ts`: frequency-tolerance matching and scores. `src/lib/referenceColors.ts`: stable colors derived from reference IDs. |
| Ping list and saving | `src/components/DetectedPingsList.tsx`: newest-first display, match banners, dismissal, and save dialog. |
| Frequency controls | `src/hooks/useFrequencyRange.ts` and `src/components/FrequencyRangeControls.tsx`: persisted range, clamping, numeric inputs, and reset. |
| Electron boundary | `electron/main.ts`: window, permissions, IPC handlers, DB lifetime. `electron/preload.ts`: narrow renderer API. |
| Persistence and types | `src-electron/db/coinPingDb.ts` and adjacent schema/validation files: SQLite catalogs and migrations. `electron/catalogFiles.ts`: managed media and backup folders. `src/types/catalog.ts` and `src/types/coinPing.ts`: shared contracts. |
| Styling and builds | `src/styles.css`, `vite.config.ts`, `tsconfig.json`, and `tsconfig.electron.json`. |

## Setup and commands

Use Yarn Classic 1.22.22, as declared by `packageManager`, and preserve `yarn.lock`. Avoid introducing another package-manager lockfile.

`.nvmrc` selects Node 20, but `scripts/check-node.cjs` only checks the major version. The installed Vite 8 and React plugin packages declare `^20.19.0 || >=22.12.0`; use a compatible version rather than assuming any Node 20 release works.

```sh
nvm use
yarn install --frozen-lockfile
yarn dev
```

Install dependencies when needed; an existing usable `node_modules/` does not require reinstallation for every task.

| Command | Purpose and limits |
| --- | --- |
| `yarn dev` | Runs the Node check, Vite on `127.0.0.1:5173`, and Electron after compiling its sources. |
| `yarn dev:renderer` | Starts Vite alone; useful for renderer work, but has no Electron preload or database API. |
| `yarn dev:electron` | Compiles Electron, waits for Vite, and launches with `VITE_DEV_SERVER_URL`. Requires a running renderer server. |
| `yarn exec tsc --noEmit -p tsconfig.json` | Checks renderer and Vite-config types. |
| `yarn exec tsc --noEmit -p tsconfig.electron.json` | Checks Electron, persistence, and shared types without emitting files. |
| `yarn test` | Runs synthetic detector, mocked audio lifecycle, reference-saving, and production asset-path regressions. |
| `yarn build` | Builds the renderer into `dist/` and Electron into `dist-electron/`. Does not run the renderer type check. |
| `yarn build:renderer` / `yarn build:electron` | Builds the affected side independently. |
| `yarn preview` | Serves the built renderer in a browser; does not launch Electron. |

Electron main/preload changes require a rebuild and process restart; the dev script has no Electron TypeScript watcher. The launch script deliberately unsets `ELECTRON_RUN_AS_NODE`; preserve that behavior. Electron starts from `dist-electron/electron/main.js` and loads `dist/index.html` when no dev-server URL is supplied. Keep Vite's relative `base: "./"` so assets resolve under `file://`. A successful build creates bundles, not a distributable installer.

## Process and persistence boundaries

- Keep filesystem and SQLite access in the Electron main process. Preserve `contextIsolation: true` and `nodeIntegration: false`.
- Renderer persistence goes through `window.coinPingApi`: `listReferences`, `createReference`, and `deleteReference`, backed by `references:list`, `references:create`, and `references:delete` IPC channels. Extend shared types, preload, main handlers, and consumers together when changing this API; do not expose raw `ipcRenderer`.
- Renderer imports use extensionless relative paths. Electron and DB sources use `.js` relative import specifiers in TypeScript because they compile with Node16 module resolution into a CommonJS package. Keep the two build configurations distinct.
- `node:sqlite` runs inside Electron's embedded Node runtime. A successful shell Node version check does not establish that the shell runtime can execute database code; run DB checks with a runtime that actually provides this module.
- `CatalogFiles` resolves the active database under `app.getPath("userData")`. On existing installs it opens the original database and applies versioned migrations. A restored backup activates a new local copy. Use a temporary library for development checks.
- Keep existing reference IDs and peak data through migrations. Legacy references have a null `coin_id` until linked. The DB enables WAL, uses parameterized statements, and checkpoints/closes on shutdown.
- Specs describe a coin variant. A test session groups readings, saved photo alignments, and sound results. Store the specification snapshot used to assess a reading so later edits preserve the original decision.
- The renderer displays managed photos through `coin-media://image/<id>`. Photo imports copy the original and create a thumbnail. Backup and restore move the database and its referenced media together.
- Reference creation requires a nonblank label, at least one peak, positive finite frequencies, and finite magnitudes. Keep validation at the persistence boundary as well as user-facing form checks; TypeScript types do not validate incoming IPC values.
- Saved references contain peak metadata, not audio files or spectrum buffers. The save dialog preserves `frequencyHz`, `magnitude`, `kind`, `sustainMs`, and `accumulatedPowerDb`. Preserve classification so matching can prefer long peaks on both sides, while continuing to support older rows without optional fields.
- The delete API exists, but the current reference sidebar has no delete control. Dismissing a detected ping only removes transient in-memory state.

## Audio and numerical contracts

The live pipeline is microphone → gain → analyser → optional ambient correction → detector and UI snapshots. The analyser is not connected to the speakers. Recording uses `MediaRecorder` on the original stream and is analyzed separately after stopping.

- `SpectrumData.values` contains per-bin dB values in a `Float32Array`, together with the spectrum's own `sampleRate`, `fftSize`, and optional ambient-subtraction flag. Frequency is `bin * sampleRate / fftSize`; do not assume every input is 48 kHz.
- Clamp visible ranges using `clampFrequencyRange`: minimum 50 Hz, maximum `min(30_000, sampleRate / 2)`, and minimum span 100 Hz. Defaults are 500–30,000 Hz before clamping.
- Default FFT size is 8192. `resolveFftSizeForSpan` increases it up to 32768 for narrow views below a 4000 Hz span. When FFT size changes, resize analysis buffers, cancel any active ambient capture, and invalidate incompatible calibration. Ambient profiles must contain `fftSize / 2` bins. Retained captured spectra still use their original FFT and sample rate when drawn.
- Average, integrate, and subtract power in the linear domain (`10 ** (dB / 10)`), then convert back with `10 * log10`. Ambient capture lasts 5000 ms; subtraction removes 55% of measured ambient power while retaining at least 50% of raw signal power. Apply a profile only when both sample rate and FFT size match.
- `LIVE_INPUT_GAIN` changes the signal entering analysis; `LIVE_DISPLAY_BOOST_DB` changes its display. Keep display boosts out of detector inputs and saved peak magnitudes.
- Browser echo cancellation, noise suppression, and automatic gain control are disabled for analysis. Preserve that choice unless intentionally changing the audio model.
- Reuse buffers in the live loop, then clone mutable arrays when retaining snapshots in React state or detected pings. Live spectrum state is throttled to 50 ms updates; ambient progress uses 100 ms updates. Do not assume overlay/progress updates share that throttle.
- Stop media tracks, cancel animation frames, close AudioContexts, and release event handlers on shutdown/unmount. Preserve the pending-start token and mounted-state guards: canceled requests must dispose their own resources without interfering with newer sessions. Exercise repeated start/stop under React StrictMode.
- Manual recordings stop automatically at 60 seconds. Automatic ping history is capped at 50 entries; manual peaks append to the latest ping or create one when the list is empty.

## Detection and matching behavior

Detection uses the visible frequency band with a default 4000 Hz lower floor. The low-frequency toggle removes that floor, and an empty detection band disables detection. Ambient capture suspends detector feeding.

`createPingDetector` moves through idle → capturing → refractory. It triggers on band mean power above an adaptive baseline, retains per-bin capture maxima, and accumulates sustained post-transient power. A separate preview buffer decays for live display; never use that decaying buffer for peak magnitude or sustain classification. Current defaults:

| Parameter | Value / interpretation |
| --- | --- |
| Trigger | At least 12 dB above baseline, with band level at least -85 dB. |
| Capture / refractory | Both 5000 ms, measured from trigger time; refractory is not an additional five-second delay after capture. |
| Sustain | Within 8 dB of the running per-bin hold; at least 100 ms to retain a peak, at least 200 ms to classify it as long. |
| Power accumulation | Skips the initial 60 ms and requires 250 ms continuous sustain plus a level floor. |
| Ranking | Uses accumulated power when available, adds a 10 dB bonus for long peaks, retains up to six peaks, then sorts by frequency. |

The accumulated spectrum integrates qualifying linear power over time and divides by a shared elapsed post-delay window. Do not normalize each bin only by its own active time: that changes the meaning of the red overlay and the ranking.

Duplicate detection compares `peaks[0]` with existing pings using `max(20 Hz, 0.5% of candidate frequency)`. Automatically emitted peaks are frequency-sorted, so this is the lowest-frequency retained peak, even though some comments call it the "top" peak. Check duplicate detection and default labels when changing peak ordering.

Reference matching uses a different tolerance: `max(20 Hz, 1.5% of reference frequency)`. It prefers long peaks on each side when available, otherwise falls back to all peaks. The score is matched eligible reference peaks divided by eligible reference peaks, with a default minimum of 0.6; ties favor lower mean Hz error. Matching is reference coverage, allows one candidate peak to satisfy multiple reference peaks, and does not use magnitude as a distance metric. UI peak-count labels use `comparedRefPeakCount` from the matcher so the displayed ratio agrees with the score.

## Chart and UI constraints

- Green overlays show captured max-hold; red overlays show time-averaged sustained power. Keep detector buffers, retained overlay state, and canvas bar peak-hold distinct. Detector resets for zoom/FFT changes deliberately retain the last chart overlays; explicit clear operations reset and lock out stale detector snapshots.
- Capture overlays can exist even when no valid ping is emitted or a duplicate ping is rejected. Do not derive every overlay exclusively from the detected-ping list.
- Canvas rendering accounts for device-pixel ratio and container resize. Sample each overlay using its own spectrum metadata, and keep wheel zoom and right-click frequency mapping consistent with the displayed logarithmic axis.
- The canvas wheel handler uses `{ passive: false }` to prevent page scrolling. The native `contextmenu` handler must leave `preventDefault()` to the parent Radix context-menu trigger; preventing it early stops the custom menu from opening.
- Reuse `@sqlrooms/ui` controls and theme tokens. Keep the `@source` directive for that package in `src/styles.css`; its utility classes would otherwise be omitted by Tailwind's dependency scanning.
- Use `getReferenceColor(reference.id)` for both sidebar and chart markers. Reference highlight bands are fixed pixel widths, not the numerical matcher tolerance.
- Frequency range persists under `coin-ping-test-freq-range`; theme uses `coin-ping-test-theme`. Ambient calibration, detected pings, recording blobs, and reference selection are session state.
- Explicit range Apply/Reset clears ambient calibration. Wheel zoom calls `setRange` directly; it invalidates calibration when the resulting FFT changes. Check both paths when changing range/calibration behavior.

## Verification for changes

Choose checks for the affected behavior. Run `yarn test` for the covered regression cases. For TypeScript changes, run the relevant type check above; run both for shared contracts. For build/configuration changes, also run `yarn build`. Tests transpile actual TypeScript sources and inject browser/hook boundaries; they do not replace hardware or Electron UI testing. There is no `yarn lint` script.

For audio, rendering, or persistence changes, exercise the relevant cases in Electron:

1. Start/stop listening repeatedly; check permission denial and device disconnection handling when feasible.
2. Capture ambient, toggle subtraction, change the visible range, and zoom across FFT sizes. Confirm calibration compatibility and retained overlay alignment.
3. Detect a sustained ping and a short transient; inspect classification, capture progress, duplicate handling, and clearing/dismissing overlays. Verify a fresh capture works after clearing.
4. Record, stop, and clear a manual recording; use the live chart context menu to add long and short peaks.
5. Save a reference to a temporary test library, reload/restart, compare matches, and toggle multiple reference overlays. Verify dialogs, colors, labels, and window resizing.

For numerical changes, prefer deterministic synthetic spectra and timestamps around thresholds, sustain durations, and tolerance boundaries. Keep database checks isolated in a temporary file. Add focused regression coverage when behavior warrants it, and state what was actually checked; compiling does not verify microphone behavior or desktop rendering.

Verify actual capture duration against `AMBIENT_CAPTURE_MS` when editing calibration controls or copy.
