const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { app, dialog, nativeImage, systemPreferences } = require("electron");
const { DatabaseSync } = require("node:sqlite");

const profile = process.env.COIN_TEST_PROFILE;
if (!profile || !path.basename(profile).startsWith("coin-ping-ui-")) {
  throw new Error("Launch this test through yarn test:electron.");
}
const root = path.resolve(__dirname, "../..");
const fileChoices = [];

function installFixtures() {
  app.setPath("userData", profile);
  const legacy = new DatabaseSync(path.join(profile, "coin-ping-test.sqlite"));
  legacy.exec(`CREATE TABLE reference_recordings (id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL, peaks_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  legacy.prepare("INSERT INTO reference_recordings (label, peaks_json) VALUES (?, ?)")
    .run("Legacy 6 kHz ping", JSON.stringify([{ frequencyHz: 6_000, magnitude: -20 }]));
  legacy.close();

  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  systemPreferences.getMediaAccessStatus = () => "granted";
  dialog.showOpenDialog = async () => {
    assert.ok(fileChoices.length, "The application opened an unexpected file chooser");
    const file = fileChoices.shift();
    return file === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [file] };
  };
  dialog.showMessageBox = async () => ({ response: 1 });
  dialog.showErrorBox = (title, message) => fail(new Error(`${title}: ${message}`));
}

function fail(error) {
  console.error(error);
  app.exit(1);
}

function renderer(win) {
  const execute = (source) => win.webContents.executeJavaScript(source, true);
  const call = (fn, ...args) => execute(`(${fn})(...${JSON.stringify(args)})`);

  async function until(description, condition, ...args) {
    const deadline = Date.now() + 10_000;
    do {
      if (await call(condition, ...args)) return;
      await delay(60);
    } while (Date.now() < deadline);
    const context = await call(() => document.body.innerText);
    throw new Error(`Timed out waiting for ${description}\n${context}`);
  }

  return {
    call,
    until,
    async text(value) {
      await until(value, (text) => document.body.innerText.includes(text), value);
    },
    async click(label, within = "body") {
      await until(`the ${label} button`, (text, selector) => {
        const button = [...(document.querySelector(selector)?.querySelectorAll("button, summary") ?? [])]
          .find((node) => node.textContent.trim() === text && node.getClientRects().length && !node.matches(":disabled"));
        if (!button) return false;
        button.click();
        return true;
      }, label, within);
    },
    async field(label, value, within = "body") {
      await until(`the ${label} field`, (text, next, selector) => {
        const labels = document.querySelector(selector)?.querySelectorAll("label") ?? [];
        const labelNode = [...labels].find((node) => node.textContent.trim() === text && node.getClientRects().length);
        const control = labelNode?.control ?? [...(document.querySelector(selector)?.querySelectorAll("[aria-label]") ?? [])]
          .find((node) => node.getAttribute("aria-label") === text && node.matches("input, select, textarea") && node.getClientRects().length);
        if (!control || control.matches(":disabled")) return false;
        const prototype = Object.getPrototypeOf(control);
        if (control instanceof HTMLSelectElement && ![...control.options].some((option) => option.value === next)) return false;
        control.focus();
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, next);
        control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
        return true;
      }, label, String(value), within);
      await call(() => document.activeElement.blur());
    },
  };
}

async function captureScreenshot(win, name) {
  const directory = process.env.COIN_TEST_SCREENSHOTS;
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.png`), (await win.capturePage()).toPNG());
}

async function playSavedRecording(ui) {
  await ui.until("the saved audio result", () => {
    const summary = [...document.querySelectorAll("summary")].find((node) =>
      node.textContent.trim().endsWith("· Recording") && node.getClientRects().length);
    if (!summary) return false;
    if (!summary.parentElement.open) summary.click();
    return true;
  });
  const selector = 'audio[aria-label="Recorded ping"]';
  await ui.until("the saved audio can be decoded", (audioSelector) => document.querySelector(audioSelector)?.readyState >= 1, selector);
  await ui.call(async (audioSelector) => {
    const audio = document.querySelector(audioSelector);
    audio.muted = true;
    await audio.play();
  }, selector);
  await ui.until("the recording plays", (audioSelector) => document.querySelector(audioSelector)?.currentTime > 0, selector);
  await ui.call((audioSelector) => document.querySelector(audioSelector).pause(), selector);
}

async function workflows(win) {
  const ui = renderer(win);
  // Exercise the minimum supported desktop window as well as the normal size.
  win.setSize(960, 600);
  await ui.text("Coin catalog");
  await ui.click("Add coin");
  await ui.field("Coin name", "Test Crown");
  await ui.field("Country or issuer", "United Kingdom");
  await ui.field("Year or start year", "1900");
  await ui.click("Create coin");
  await ui.text("Coin details");
  await ui.click("Edit details");
  await ui.field("Coin name", "Silver Crown");
  await ui.click("Save details");
  await ui.text("Silver Crown");
  const coinId = await ui.call(async () => (await window.coinCatalogApi.listCoins())[0].id);

  await ui.click("Add specification");
  await ui.field("Metric", "conductivity");
  await ui.field("Minimum (MS/m)", "44");
  await ui.field("Maximum (MS/m)", "46");
  await ui.click("Save specification");
  await ui.text("44–46 MS/m");
  await ui.click("Start new specimen test");
  await ui.field("Specimen name", "Bench specimen A", '[role="dialog"]');
  await ui.click("Create specimen session", '[role="dialog"]');
  await ui.text("Bench specimen A");
  await ui.until("the empty session checklist", () =>
    [...document.querySelectorAll('[aria-label="Session checklist"] li')].filter((item) => item.textContent.includes("Missing")).length === 6);
  await ui.click("Add reading");
  await ui.field("Metric", "conductivity");
  await ui.field("Reading (MS/m)", "47");
  const specId = await ui.call(async (id) => (await window.coinCatalogApi.getCoin(id)).specifications[0].id, coinId);
  await ui.field("Reference range", specId);
  await ui.click("Save reading");
  await ui.until("the checklist warns about the original reading", () =>
    document.querySelector('[aria-label="Session checklist"]')?.textContent.includes("Outside range"));
  const specimen = await ui.call(async (id) => (await window.coinCatalogApi.getCoin(id)).sessions[0], coinId);
  await ui.click("Edit reading");
  await ui.field("Reading (MS/m)", "45");
  await ui.click("Save reading");
  await ui.until("correcting the reading updates the checklist", () =>
    document.querySelector('[aria-label="Session checklist"]')?.textContent.includes("Within range"));

  const photoPath = path.join(profile, "photo.png");
  const bitmap = Buffer.alloc(48 * 48 * 4, 230);
  fs.writeFileSync(photoPath, nativeImage.createFromBitmap(bitmap, { width: 48, height: 48 }).toPNG());
  for (const side of ["Obverse", "Reverse", "Edge"]) {
    await ui.click("Add photo", `section[aria-label="${side}"]`);
    fileChoices.push(photoPath);
    await ui.click("Choose photo…");
    await ui.until(`the ${side} thumbnail`, (label) => {
      const img = document.querySelector(`section[aria-label="${label}"] img`);
      if (!img) return false;
      img.scrollIntoView();
      return img.complete && img.naturalWidth > 0;
    }, side);
  }
  await ui.until("all reference photo sections on one row at the minimum window size", () => {
    const tops = ["Obverse", "Reverse", "Edge"].map((side) =>
      document.querySelector(`section[aria-label="${side}"]`)?.getBoundingClientRect().top);
    return tops.every((top) => top !== undefined && Math.abs(top - tops[0]) < 2);
  });
  await captureScreenshot(win, "coin-details");

  await ui.click("Compare photo");
  await ui.text("Silver Crown · Bench specimen A");
  fileChoices.push(null);
  await ui.click("Open photo");
  fileChoices.push(photoPath);
  await ui.click("Open photo");
  await ui.click("Side by side");
  await ui.until("both photo panes", () => document.querySelectorAll(".coin-compare-stage img").length === 2);
  await ui.click("Alternate");
  await ui.click("Show reference");
  await ui.until("the alternate reference with its rotation locked", () =>
    document.querySelectorAll(".coin-compare-stage img").length === 1 &&
    document.querySelector('.coin-compare-stage img[alt="Reference coin"]') &&
    [...document.querySelectorAll("label")].some((label) => label.textContent.trim() === "Rotation (°)" &&
      label.control?.disabled && label.getClientRects().length));
  await ui.click("Show candidate");
  await ui.click("Overlay");
  await ui.field("Rotation (°)", "17");
  await ui.until("the photo preview stays visible while editing alignment", () => {
    const preview = document.querySelector(".coin-compare-stage")?.getBoundingClientRect();
    return preview && Math.min(innerHeight, preview.bottom) - Math.max(0, preview.top) >= 180;
  });
  await ui.click("Save comparison");
  await ui.until("a saved rotated overlay", async (id) => {
    const row = (await window.coinCatalogApi.getCoin(id)).sessions[0]?.comparisons[0];
    return row?.alignment.candidate.rotation === 17;
  }, coinId);
  await captureScreenshot(win, "image-comparison");
  await ui.click("Silver Crown", 'section[aria-label="Image comparison"]');
  await ui.click("Reopen");
  await ui.until("the reopened rotation", () => [...document.querySelectorAll("label")].some((label) =>
    label.textContent.trim() === "Rotation (°)" && label.control?.value === "17" && label.getClientRects().length));

  await ui.click("Sound analysis");
  await ui.text("Silver Crown · Bench specimen A");
  await ui.click("Start listening");
  await ui.until("live microphone data", () => document.body.innerText.includes("Audio sample rate"));
  await ui.until("the live spectrum visible at the minimum window size", () => {
    const plot = document.querySelector('section[aria-label="Sound analysis"] canvas')?.getBoundingClientRect();
    return plot?.width > 300 && plot.top >= 0 && Math.min(innerHeight, plot.bottom) - plot.top >= 180;
  });
  // Chromium's test device produces a 400 Hz beep below the default chart range.
  await ui.click("Frequency range and ambient settings");
  await ui.field("Min frequency (Hz)", "200");
  await ui.click("Frequency range and ambient settings");
  await ui.click("Record ping");
  await delay(1_200);
  await ui.click("Stop recording");
  await ui.text("Manual recording");
  await ui.click("Save test result");
  await ui.text("Test result saved");
  await ui.click("Save as reference…");
  await ui.field("Name", "Bench sound reference", '[role="dialog"]');
  await ui.click("Save", '[role="dialog"]');
  await ui.text("Bench sound reference");
  await ui.until("the reference dialog is closed", () => !document.querySelector('[role="dialog"]'));
  await captureScreenshot(win, "sound-analysis");

  await ui.click("Catalog");
  await ui.click("Sound analysis");
  await ui.text("Manual recording");
  await ui.click("Start listening");
  await ui.text("Manual recording");
  await ui.until("live plot after restarting the microphone", () =>
    document.querySelector('[aria-label="Live spectrum"] canvas')?.getClientRects().length > 0);
  await ui.click("Show recording");
  await ui.until("the previous take is still available", () =>
    document.querySelector('[aria-label="Recording spectrum"] canvas')?.getClientRects().length > 0);
  await ui.click("Show live spectrum");
  await ui.click("Clear recording");
  await ui.until("the completed take is cleared", () => !document.body.innerText.includes("Manual recording"));
  await ui.click("Stop");
  await ui.click("Enter a peak manually");
  await ui.field("Peak frequency (Hz)", "5500", 'section[aria-label="Sound analysis"]');
  await ui.click("Add peak", 'section[aria-label="Sound analysis"]');
  await ui.text("5500 Hz");
  await ui.click("Save test result");
  await ui.text("Test result saved");
  const manualPeak = await ui.call(async (id) => {
    const detail = await window.coinCatalogApi.getCoin(id);
    return detail.sessions[0].soundResults.flatMap((result) => result.peaks)
      .find((peak) => peak.frequencyHz === 5500 && peak.source === "manual");
  }, coinId);
  assert.deepEqual(manualPeak, { frequencyHz: 5500, kind: "long", source: "manual" });

  await ui.click("Start new specimen test");
  await ui.field("Specimen name", "Bench specimen B", '[role="dialog"]');
  await ui.click("Create specimen session", '[role="dialog"]');
  await ui.text("Silver Crown · Bench specimen B");
  await ui.until("the first specimen's detected peaks do not carry over", () =>
    !document.querySelector('[aria-label="Sound analysis"]').innerText.includes("5500 Hz"));
  const secondSpecimenId = await ui.call(async (id) => (await window.coinCatalogApi.getCoin(id)).sessions
    .find((session) => session.label === "Bench specimen B").id, coinId);
  await ui.click("Enter a peak manually");
  await ui.field("Peak frequency (Hz)", "6200", 'section[aria-label="Sound analysis"]');
  await ui.click("Add peak", 'section[aria-label="Sound analysis"]');
  await ui.click("Save test result");
  await ui.text("Test result saved");
  await ui.click("Image comparison");
  await ui.text("Silver Crown · Bench specimen B");
  await ui.until("the new specimen's candidate picker excludes the first specimen's photo", () => {
    const label = [...document.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === "Candidate photo");
    return label?.control?.disabled && label.control.options.length === 1;
  });
  await ui.click("Sound analysis");
  await ui.field("Specimen session", specimen.id);
  await ui.text("Silver Crown · Bench specimen A");
  await ui.until("switching back does not show the second specimen's peak", () =>
    !document.querySelector('[aria-label="Sound analysis"]').innerText.includes("6200 Hz"));

  await ui.click("Catalog");
  await ui.field("Search coins", "Silv");
  await ui.field("Country", "United Kingdom");
  await ui.text("1 coin");
  await ui.until("the filtered catalog card", () => {
    const tile = document.querySelector('button[aria-label="Open Silver Crown"]');
    if (!tile || !tile.getClientRects().length) return false;
    tile.click();
    return true;
  });
  await ui.text("Within range");
  await ui.text("Sound results");
  await playSavedRecording(ui);
  await ui.click("Edit details");
  await ui.field("Country or issuer", "Canada");
  await ui.click("Save details");
  await ui.text("Canada");
  await ui.click("← Coin catalog");
  await ui.until("catalog search survives opening a card", () => document.querySelector('input[type="search"]')?.value === "Silv");
  await ui.until("the unavailable country filter is cleared and the edited coin is visible", () => {
    const country = [...document.querySelectorAll("label")].find((label) => label.textContent.trim() === "Country");
    return country?.control?.value === "" && document.querySelector('button[aria-label="Open Silver Crown"]')?.getClientRects().length > 0;
  });

  const beforeBackup = await ui.call(async (id) => ({
    detail: await window.coinCatalogApi.getCoin(id),
    references: await window.coinPingApi.listReferences(),
  }), coinId);
  assert.equal(beforeBackup.detail.sessions.length, 2);
  const first = beforeBackup.detail.sessions.find((session) => session.id === specimen.id);
  const second = beforeBackup.detail.sessions.find((session) => session.id === secondSpecimenId);
  assert.equal(first.measurements.length, 1);
  assert.equal(first.measurements[0].id, specimen.measurements[0].id);
  assert.equal(first.measurements[0].status, "within");
  assert.equal(first.measurements[0].value, 45);
  assert.equal(first.comparisons.length, 1);
  assert.equal(first.soundResults.length, 2);
  assert.equal(first.soundResults.filter((result) => result.hasAudio).length, 1);
  assert.equal(second.measurements.length, 0);
  assert.equal(second.comparisons.length, 0);
  assert.equal(second.soundResults.length, 1);
  assert.equal(second.soundResults[0].peaks[0].frequencyHz, 6200);
  assert.equal(second.soundResults[0].hasAudio, false);
  assert.equal(beforeBackup.detail.references[0].label, "Bench sound reference");
  assert.ok(beforeBackup.detail.references[0].peaks.some((peak) => Math.abs(peak.frequencyHz - 400) < 75));
  assert.equal(beforeBackup.references.find((ref) => ref.id === 1).coinId, null);

  const backupParent = fs.mkdtempSync(path.join(profile, "backup-"));
  fileChoices.push(backupParent);
  await ui.click("Back up library");
  await ui.text("Coin library backup saved");
  const backup = path.join(backupParent, fs.readdirSync(backupParent)[0]);
  await ui.call((id) => window.coinCatalogApi.updateCoin(id, { name: "Changed after backup" }), coinId);
  assert.equal(await ui.call(async (id) => (await window.coinCatalogApi.getCoin(id)).name, coinId), "Changed after backup");
  fileChoices.push(backup);
  const reloaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  await ui.click("Restore backup");
  await reloaded;
  await ui.until("the restored catalog and name", () => document.body.innerText.includes("Silver Crown") &&
    document.body.innerText.includes("Coin catalog"));
  assert.deepEqual(await ui.call((id) => window.coinCatalogApi.getCoin(id), coinId), beforeBackup.detail);
  await captureScreenshot(win, "catalog");
  await ui.until("the restored coin card", () => {
    const card = document.querySelector('button[aria-label="Open Silver Crown"]');
    if (!card?.getClientRects().length) return false;
    card.click();
    return true;
  });
  await playSavedRecording(ui);
  assert.equal(fileChoices.length, 0);
  console.log("Electron workflows passed: separate specimen tests, checklist and reading correction, photo alignment, saved audio playback, backup and restore.");
}

installFixtures();
setTimeout(() => fail(new Error("Electron workflow check exceeded its time limit")), 100_000).unref();
app.once("browser-window-created", (_event, win) => {
  win.webContents.on("render-process-gone", (_event, details) => fail(new Error(`Renderer exited: ${details.reason}`)));
  win.webContents.once("did-finish-load", () => {
    workflows(win).then(() => {
      fs.writeFileSync(path.join(profile, "workflows-completed"), "", { flag: "wx" });
      app.quit();
    }).catch(fail);
  });
});
require(path.join(root, "dist-electron/electron/main.js"));
