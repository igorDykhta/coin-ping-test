import { DatabaseSync } from "node:sqlite";

import type {
  ReferenceInput,
  ReferenceRecord,
  ResonancePeak,
} from "../../src/types/coinPing.js";

type ReferenceRow = {
  id: number;
  label: string;
  peaks_json: string;
  created_at: string;
};

export class ValidationError extends Error {}

function validateInput(input: ReferenceInput): void {
  if (!input.label.trim()) {
    throw new ValidationError("Label is required.");
  }

  if (!Array.isArray(input.peaks) || input.peaks.length === 0) {
    throw new ValidationError("At least one resonance peak is required.");
  }

  for (const peak of input.peaks) {
    if (!Number.isFinite(peak.frequencyHz) || peak.frequencyHz <= 0) {
      throw new ValidationError("Peak frequency must be a positive number.");
    }
    if (!Number.isFinite(peak.magnitude) || peak.magnitude < 0) {
      throw new ValidationError("Peak magnitude must be a non-negative number.");
    }
  }
}

function parsePeaks(json: string): ResonancePeak[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid peaks data in database.");
  }
  return parsed as ResonancePeak[];
}

function toReferenceRecord(row: ReferenceRow): ReferenceRecord {
  return {
    id: row.id,
    label: row.label,
    peaks: parsePeaks(row.peaks_json),
    createdAt: row.created_at,
  };
}

export class CoinPingDb {
  private db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reference_recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        peaks_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  listReferences(): ReferenceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, label, peaks_json, created_at
         FROM reference_recordings
         ORDER BY created_at DESC`,
      )
      .all() as ReferenceRow[];

    return rows.map(toReferenceRecord);
  }

  createReference(input: ReferenceInput): ReferenceRecord {
    validateInput(input);

    const peaksJson = JSON.stringify(input.peaks);
    const result = this.db
      .prepare(
        `INSERT INTO reference_recordings (label, peaks_json)
         VALUES (?, ?)
         RETURNING id, label, peaks_json, created_at`,
      )
      .get(input.label.trim(), peaksJson) as ReferenceRow;

    return toReferenceRecord(result);
  }

  deleteReference(id: number): void {
    const result = this.db
      .prepare(`DELETE FROM reference_recordings WHERE id = ?`)
      .run(id);

    if (result.changes === 0) {
      throw new ValidationError(`Reference ${id} was not found.`);
    }
  }

  checkpointAndClose(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
    if (this.closed) {
      return;
    }

    this.db.exec(`PRAGMA wal_checkpoint(${mode});`);
    this.db.close();
    this.closed = true;
  }
}
