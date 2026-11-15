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
const load = createLoader();
const CoinPingDb = DatabaseSync && load("src-electron/db/coinPingDb.ts").CoinPingDb;
const { MAX_SOUND_AUDIO_BYTES } = load("src-electron/db/catalogValidation.ts");
const peaks = [{ frequencyHz: 4800, magnitude: -32 }];
const bytes = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);
const audio = { mimeType: "audio/webm;codecs=opus", bytes };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coin-audio-db-"));
  const connections = [];
  t.after(() => {
    for (const connection of connections) connection.checkpointAndClose();
    fs.rmSync(directory, { force: true, recursive: true });
  });
  return {
    filename: (name) => path.join(directory, name),
    open(filename) {
      const db = new CoinPingDb(filename);
      connections.push(db);
      return db;
    },
  };
}

run("keeps each result's audio through close, reopen, and backup without returning bytes in history", async (t) => {
  const { filename, open } = fixture(t);
  const original = filename("catalog.sqlite");
  const snapshot = filename("backup.sqlite");
  const db = open(original);
  const coin = db.createCoin({ name: "Crown" });
  const first = db.createSession(coin.id, { label: "Specimen A" });
  const second = db.createSession(coin.id, { label: "Specimen B" });
  const recorded = db.saveSoundResult(first.id, { label: "Recorded ping", peaks }, audio);
  const otherBytes = Uint8Array.of(0x52, 0x49, 0x46, 0x46);
  const quiet = db.saveSoundResult(second.id, { label: "Quiet recording", peaks: [] }, { mimeType: "audio/wav", bytes: otherBytes });
  const manuallyEntered = db.saveSoundResult(second.id, { label: "Peaks only", peaks });
  assert.equal(recorded.hasAudio, true);
  assert.equal(manuallyEntered.hasAudio, false);
  db.checkpointAndClose();

  await open(original).backupTo(snapshot);
  assert.deepEqual(CoinPingDb.validateBackup(snapshot), []);
  const restored = open(snapshot);
  const sessions = restored.getCoin(coin.id).sessions;
  assert.deepEqual(sessions.find((session) => session.id === first.id).soundResults, [recorded]);
  assert.deepEqual(sessions.find((session) => session.id === second.id).soundResults, [manuallyEntered, quiet]);
  assert.deepEqual(restored.getSoundAudio(recorded.id), { mimeType: "audio/webm", bytes });
  assert.deepEqual(restored.getSoundAudio(quiet.id), { mimeType: "audio/wav", bytes: otherBytes });
  assert.equal(restored.getSoundAudio(manuallyEntered.id), null);
  assert.equal(restored.getSoundAudio(1000), null);
  assert.throws(() => restored.getSoundAudio(-1), /valid ID/);
});

run("rejects invalid recordings without creating a partial sound result", (t) => {
  const { filename, open } = fixture(t);
  const file = filename("catalog.sqlite");
  const db = open(file);
  const coin = db.createCoin({ name: "Crown" });
  const session = db.createSession(coin.id, { label: "Specimen" });
  const result = { label: "Ping", peaks };
  assert.throws(() => db.saveSoundResult(session.id, { ...result, peaks: [] }), /peak/i);
  assert.throws(() => db.createReference({ label: "Quiet reference", peaks: [] }), /peak/i);
  assert.throws(() => db.saveSoundResult(session.id, result, { bytes, mimeType: "text/html" }), /Unsupported/);
  assert.throws(() => db.saveSoundResult(session.id, result, { ...audio, bytes: new Uint8Array() }), /audio data/);
  assert.throws(() => db.saveSoundResult(session.id, result, { ...audio, bytes: [1, 2] }), /audio data/);
  assert.throws(() => db.saveSoundResult(session.id, result, { ...audio, bytes: new Uint8Array(MAX_SOUND_AUDIO_BYTES + 1) }), /16 MiB/);
  assert.throws(() => db.saveSoundResult(session.id, { ...result, peaks: null }, audio), /peak/i);

  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TRIGGER simulate_audio_failure BEFORE INSERT ON sound_result_audio
    BEGIN SELECT RAISE(ABORT, 'Simulated audio write failure'); END`);
  raw.close();
  assert.throws(() => db.saveSoundResult(session.id, result, audio), /Simulated audio write failure/);
  assert.deepEqual(db.getCoin(coin.id).sessions[0], session);
});

run("accepts version 1 backups and migrates their existing results without requiring audio", (t) => {
  const { filename, open } = fixture(t);
  const file = filename("old-catalog.sqlite");
  const { migrateCatalog } = load("src-electron/db/catalogSchema.ts");
  const raw = new DatabaseSync(file);
  migrateCatalog(raw, 1);
  const time = "2026-11-15T15:20:00.000Z";
  raw.prepare("INSERT INTO coins (id, name, created_at, updated_at) VALUES (1, 'Crown', ?, ?)").run(time, time);
  raw.prepare("INSERT INTO test_sessions (id, coin_id, label, created_at, updated_at) VALUES (1, 1, 'Specimen', ?, ?)").run(time, time);
  raw.prepare("INSERT INTO sound_results (id, session_id, label, peaks_json, created_at) VALUES (1, 1, 'Peaks', ?, ?)")
    .run(JSON.stringify(peaks), time);
  raw.close();

  assert.deepEqual(CoinPingDb.validateBackup(file), []);
  const migrated = open(file);
  const [original] = migrated.getCoin(1).sessions[0].soundResults;
  assert.equal(original.id, 1);
  assert.deepEqual(original.peaks, peaks);
  assert.equal(original.hasAudio, false);
  assert.equal(migrated.getSoundAudio(1), null);
  const appended = migrated.saveSoundResult(1, { label: "New recording", peaks }, audio);
  assert.deepEqual(migrated.getSoundAudio(appended.id), { mimeType: "audio/webm", bytes });
});
