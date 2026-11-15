const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createLoader } = require("./helpers.cjs");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
}
const run = (name, fn) => test(name, { skip: !DatabaseSync && "This shell Node runtime has no node:sqlite." }, fn);
const CoinPingDb = DatabaseSync && createLoader()("src-electron/db/coinPingDb.ts").CoinPingDb;
const peaks = [{ frequencyHz: 5500, magnitude: -22, kind: "long", sustainMs: 240 }];

function fileFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coin-catalog-test-"));
  const connections = [];
  t.after(() => {
    for (const db of connections) db.checkpointAndClose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    open(filename) {
      const db = new CoinPingDb(filename);
      connections.push(db);
      return db;
    },
  };
}

function open(t, filename = ":memory:") {
  const db = new CoinPingDb(filename);
  t.after(() => db.checkpointAndClose());
  return db;
}

run("migrates the original reference library without changing record IDs or peak data", async (t) => {
  const { dir, open } = fileFixture(t);
  const filename = path.join(dir, "legacy.sqlite");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE reference_recordings (id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL, peaks_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  legacy.prepare("INSERT INTO reference_recordings VALUES (?, ?, ?, ?)").run(
    42, "Original reference", JSON.stringify(peaks), "2026-01-10 12:00:00",
  );
  legacy.close();

  const db = open(filename);
  assert.deepEqual(db.listReferences(), [{
    id: 42, label: "Original reference", peaks, createdAt: "2026-01-10 12:00:00", coinId: null,
  }]);
  const coin = db.createCoin({ name: "Walking Liberty", country: "US", yearFrom: 1916, yearTo: 1947 });
  assert.equal(db.linkReference(42, coin.id).coinId, coin.id);
  assert.equal(db.getCoin(coin.id).references[0].id, 42);
  assert.equal(db.listCoins()[0].referenceCount, 1);
  const backup = path.join(dir, "legacy-upgraded.sqlite");
  await db.backupTo(backup);
  assert.deepEqual(CoinPingDb.validateBackup(backup), []);
  db.checkpointAndClose();

  const reopened = open(filename);
  assert.deepEqual(reopened.listReferences(coin.id)[0].peaks, peaks);
  assert.equal(reopened.linkReference(42, null).coinId, null);
  assert.equal(reopened.getCoin(coin.id).references.length, 0);
});

run("stores range decisions and the original specification in a session", (t) => {
  const db = open(t);
  const coin = db.createCoin({ name: "Gold coin" });
  const secondCoin = db.createCoin({ name: "Silver coin" });
  const range = db.createSpecification(coin.id, {
    metric: "conductivity", min: 40, max: 45, nominal: 42, source: "Known specimen",
  });
  const session = db.createSession(coin.id, { label: "First measurement" });
  const value = (number) => ({ metric: "conductivity", value: number, specificationId: range.id });
  assert.equal(db.createMeasurement(session.id, value(40)).status, "within");
  assert.equal(db.createMeasurement(session.id, value(45)).status, "within");
  assert.equal(db.createMeasurement(session.id, value(46)).status, "outside");
  assert.equal(db.createMeasurement(session.id, { metric: "conductivity", value: 0 }).status, "not-assessed");
  assert.throws(() => db.createMeasurement(session.id, { ...value(42), metric: "density" }), /specification for this coin/);
  const otherSession = db.createSession(secondCoin.id, { label: "Other coin" });
  assert.throws(() => db.createMeasurement(otherSession.id, value(42)), /specification for this coin/);
  assert.throws(() => db.createSpecification(coin.id, { metric: "density", min: 10.5, max: 10 }), /minimum/);

  db.updateSpecification(range.id, { metric: "conductivity", min: 42, max: 43 });
  db.deleteSpecification(range.id);
  const history = db.getCoin(coin.id).sessions[0].measurements.find((item) => item.value === 40);
  assert.equal(history.status, "within");
  assert.deepEqual(history.specification, range);
  assert.equal(db.getCoin(coin.id).specifications.length, 0);
});

run("saves and restores independently aligned photos, protects referenced media, and restores the catalog backup", async (t) => {
  const { dir, open } = fileFixture(t);
  const filename = path.join(dir, "catalog.sqlite");
  const db = open(filename);
  const coin = db.createCoin({ name: "Catalog reference" });
  const key = (id) => `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}.jpg`;
  const image = (id, side, role = "reference") => db.addImage({
    coinId: coin.id, side, role, assetKey: key(id), width: 800, height: 800,
  });
  const firstReference = image(1, "obverse");
  const reference = image(2, "obverse");
  const candidate = image(3, "obverse", "candidate");
  const otherFace = image(4, "reverse", "candidate");
  const session = db.createSession(coin.id, { label: "Side-by-side test" });
  const alignment = {
    reference: { x: 0.1, y: 0.2, rotation: 10, scale: 1.1 },
    candidate: { x: 0.3, y: -0.4, rotation: -30, scale: 0.9 },
    opacity: 0.25, view: "side-by-side", locked: false, guides: true, rimRadius: 0.4,
    guideX: 0.03, guideY: -0.04, zoom: 2, pan: { x: 1, y: -1 },
  };
  const input = { side: "obverse", referenceImageId: reference.id, candidateImageId: candidate.id, alignment };
  assert.equal(firstReference.isPrimary, true);
  assert.equal(reference.isPrimary, false);
  db.setPrimaryImage(reference.id);
  assert.equal(db.getCoin(coin.id).primaryObverseId, reference.id);
  assert.throws(() => db.createComparison(session.id, { ...input, candidateImageId: otherFace.id }), /same coin face/);
  assert.throws(() => db.addImage({
    coinId: coin.id, side: "edge", assetKey: "../invalid.jpg", width: 1, height: 1,
  }), /Invalid image/);
  const comparison = db.createComparison(session.id, input);
  assert.throws(() => db.deleteImage(candidate.id), /used by a saved comparison/);
  const updated = db.updateComparison(comparison.id, { ...input, alignment: { ...alignment, opacity: 0.6 } });
  assert.equal(updated.alignment.opacity, 0.6);
  const referencePing = db.createReference({ label: "Known", coinId: coin.id, peaks });
  const sound = db.saveSoundResult(session.id, {
    label: "Test strike", peaks, matches: [{ referenceId: referencePing.id, label: referencePing.label, score: 1 }],
  });
  db.archiveCoin(coin.id);
  assert.equal(db.getCoin(coin.id).archived, true);
  db.restoreCoin(coin.id);

  const backup = path.join(dir, "backup.sqlite");
  await db.backupTo(backup);
  assert.deepEqual(CoinPingDb.validateBackup(backup), [key(1), key(2), key(3), key(4)]);
  const restored = open(backup);
  assert.equal(restored.getImageAssetKey(candidate.id), key(3));
  assert.deepEqual(restored.getCoin(coin.id).sessions[0].comparisons, [updated]);
  assert.deepEqual(restored.getCoin(coin.id).sessions[0].soundResults, [sound]);
  assert.equal(restored.getCoin(coin.id).archived, false);
});

run("rejects an imported snapshot containing a modified schema", (t) => {
  const { dir, open } = fileFixture(t);
  const filename = path.join(dir, "unexpected.sqlite");
  const db = open(filename);
  db.checkpointAndClose();
  const modified = new DatabaseSync(filename);
  modified.exec("CREATE TRIGGER catalog_delete AFTER INSERT ON coins BEGIN DELETE FROM reference_recordings; END");
  modified.close();
  assert.throws(() => CoinPingDb.validateBackup(filename), /unexpected database structure/);
});
