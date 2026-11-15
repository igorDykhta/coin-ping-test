import type { DatabaseSync } from "node:sqlite";
import { MAX_SOUND_AUDIO_BYTES, SOUND_AUDIO_TYPES } from "./catalogValidation.js";

export const CATALOG_SCHEMA_VERSION = 2;

const REFERENCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS reference_recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    peaks_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const CATALOG_SCHEMA = `
  CREATE TABLE coins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    country TEXT,
    denomination TEXT,
    year_from INTEGER,
    year_to INTEGER,
    mint TEXT,
    variant TEXT,
    composition TEXT,
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  ALTER TABLE reference_recordings ADD COLUMN coin_id INTEGER REFERENCES coins(id);
  CREATE INDEX reference_coin_idx ON reference_recordings(coin_id);

  CREATE TABLE specifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_id INTEGER NOT NULL REFERENCES coins(id),
    metric TEXT NOT NULL CHECK (metric IN ('weight', 'density', 'conductivity')),
    nominal REAL,
    min REAL,
    max REAL,
    source TEXT,
    notes TEXT
  );
  CREATE INDEX specification_coin_idx ON specifications(coin_id);

  CREATE TABLE coin_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_id INTEGER NOT NULL REFERENCES coins(id),
    side TEXT NOT NULL CHECK (side IN ('obverse', 'reverse', 'edge')),
    role TEXT NOT NULL CHECK (role IN ('reference', 'candidate')),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    asset_key TEXT NOT NULL UNIQUE,
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    credit TEXT,
    source TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX coin_image_coin_idx ON coin_images(coin_id);
  CREATE UNIQUE INDEX coin_primary_face_idx ON coin_images(coin_id, side) WHERE is_primary = 1;

  CREATE TABLE test_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coin_id INTEGER NOT NULL REFERENCES coins(id),
    label TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX session_coin_idx ON test_sessions(coin_id);

  CREATE TABLE session_measurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES test_sessions(id),
    metric TEXT NOT NULL CHECK (metric IN ('weight', 'density', 'conductivity')),
    value REAL NOT NULL,
    specification_json TEXT,
    status TEXT NOT NULL CHECK (status IN ('within', 'outside', 'not-assessed')),
    method TEXT,
    notes TEXT,
    measured_at TEXT NOT NULL
  );
  CREATE INDEX measurement_session_idx ON session_measurements(session_id);

  CREATE TABLE image_comparisons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES test_sessions(id),
    side TEXT NOT NULL CHECK (side IN ('obverse', 'reverse')),
    reference_image_id INTEGER NOT NULL REFERENCES coin_images(id),
    candidate_image_id INTEGER NOT NULL REFERENCES coin_images(id),
    alignment_json TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX comparison_session_idx ON image_comparisons(session_id);

  CREATE TABLE sound_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES test_sessions(id),
    label TEXT NOT NULL,
    peaks_json TEXT NOT NULL,
    matches_json TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX sound_session_idx ON sound_results(session_id);
`;

const SOUND_AUDIO_SCHEMA = `
  CREATE TABLE sound_result_audio (
    sound_result_id INTEGER PRIMARY KEY REFERENCES sound_results(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL CHECK (mime_type IN (${SOUND_AUDIO_TYPES.map((type) => `'${type}'`).join(", ")})),
    data BLOB NOT NULL CHECK (typeof(data) = 'blob' AND length(data) BETWEEN 1 AND ${MAX_SOUND_AUDIO_BYTES})
  );
`;

export function schemaVersion(db: DatabaseSync): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version);
}

export function migrateCatalog(db: DatabaseSync, targetVersion: 1 | 2 = CATALOG_SCHEMA_VERSION): void {
  const version = schemaVersion(db);
  if (version > targetVersion) {
    throw new Error("This catalog was created by a newer version of Coin Ping Analyzer.");
  }
  if (version === targetVersion) {
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    if (version < 1) {
      db.exec(REFERENCE_SCHEMA);
      db.exec(CATALOG_SCHEMA);
    }
    if (targetVersion >= 2) db.exec(SOUND_AUDIO_SCHEMA);
    db.exec(`PRAGMA user_version = ${targetVersion}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
