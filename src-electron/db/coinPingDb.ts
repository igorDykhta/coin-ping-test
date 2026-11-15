import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";

import type {
  CoinDetail, CoinImage, CoinInput, CoinSummary, ComparisonInput, ImageAlignment,
  ImageComparison, ImageImportInput, Measurement, MeasurementInput, MeasurementStatus,
  Session, SessionInput, SoundResult, SoundResultInput, Specification, SpecificationInput,
} from "../../src/types/catalog.js";
import type { ReferenceInput, ReferenceRecord, ResonancePeak } from "../../src/types/coinPing.js";
import { CATALOG_SCHEMA_VERSION, migrateCatalog, schemaVersion } from "./catalogSchema.js";
import {
  coinValues, comparisonAlignment, isAssetKey, metricValue, optionalText, positiveId,
  requiredText, requireObject, specificationValues, validMetric, validPeaks, validTimestamp,
  ValidationError,
} from "./catalogValidation.js";

export { ValidationError } from "./catalogValidation.js";

type ReferenceRow = Omit<ReferenceRecord, "peaks"> & { peaksJson: string };
type CoinRow = Omit<CoinSummary, "archived"> & { archived: number };
type ImageRow = Omit<CoinImage, "isPrimary"> & { isPrimary: number; assetKey: string };
type SessionRow = Omit<Session, "measurements" | "comparisons" | "soundResults">;
type MeasurementRow = Omit<Measurement, "specification" | "specificationId"> & { specificationJson: string | null };
type ComparisonRow = Omit<ImageComparison, "alignment"> & { alignmentJson: string };
type SoundResultRow = Omit<SoundResult, "peaks" | "matches"> & { peaksJson: string; matchesJson: string | null };

const REFERENCE_FIELDS = "id, label, coin_id AS coinId, peaks_json AS peaksJson, created_at AS createdAt";
const SPECIFICATION_FIELDS = "id, coin_id AS coinId, metric, nominal, min, max, source, notes";
const IMAGE_FIELDS = `id, coin_id AS coinId, side, role, is_primary AS isPrimary,
  asset_key AS assetKey, width, height, credit, source, created_at AS createdAt`;
const SESSION_FIELDS = "id, coin_id AS coinId, label, notes, created_at AS createdAt, updated_at AS updatedAt";
const MEASUREMENT_FIELDS = `id, session_id AS sessionId, metric, value, specification_json AS specificationJson,
  status, method, notes, measured_at AS measuredAt`;
const COMPARISON_FIELDS = `id, session_id AS sessionId, side, reference_image_id AS referenceImageId,
  candidate_image_id AS candidateImageId, alignment_json AS alignmentJson, notes,
  created_at AS createdAt, updated_at AS updatedAt`;
const SOUND_FIELDS = `id, session_id AS sessionId, label, peaks_json AS peaksJson, matches_json AS matchesJson,
  notes, created_at AS createdAt`;
const COIN_FIELDS = `c.id, c.name, c.country, c.denomination, c.year_from AS yearFrom, c.year_to AS yearTo,
  c.mint, c.variant, c.composition, c.notes, c.archived, c.created_at AS createdAt, c.updated_at AS updatedAt,
  (SELECT id FROM coin_images WHERE coin_id = c.id AND side = 'obverse' AND is_primary = 1) AS primaryObverseId,
  (SELECT id FROM coin_images WHERE coin_id = c.id AND side = 'reverse' AND is_primary = 1) AS primaryReverseId,
  (SELECT count(*) FROM coin_images WHERE coin_id = c.id AND role = 'reference') AS imageCount,
  (SELECT count(*) FROM reference_recordings WHERE coin_id = c.id) AS referenceCount,
  (SELECT count(*) FROM test_sessions WHERE coin_id = c.id) AS sessionCount,
  (SELECT nominal FROM specifications WHERE coin_id = c.id AND metric = 'weight' AND nominal IS NOT NULL ORDER BY id LIMIT 1) AS nominalWeight`;

function withoutNulls<T extends object>(row: T, fields: readonly (keyof T)[]): T {
  const result = { ...row };
  for (const field of fields) if (result[field] === null) delete result[field];
  return result;
}

function parsePeaks(json: string): ResonancePeak[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("Invalid peaks data in database.");
  return parsed as ResonancePeak[];
}

function toReferenceRecord({ peaksJson, ...row }: ReferenceRow): ReferenceRecord {
  return { ...row, peaks: parsePeaks(peaksJson) };
}

function toCoin(row: CoinRow): CoinSummary {
  return withoutNulls({ ...row, archived: Boolean(row.archived) }, [
    "country", "denomination", "yearFrom", "yearTo", "mint", "variant", "composition", "notes",
  ]);
}

function toSpecification(row: Specification): Specification {
  return withoutNulls(row, ["nominal", "min", "max", "source", "notes"]);
}

function toImage({ assetKey, isPrimary, ...row }: ImageRow): CoinImage {
  return withoutNulls({ ...row, isPrimary: Boolean(isPrimary) }, ["credit", "source"]);
}

function toMeasurement({ specificationJson, ...row }: MeasurementRow): Measurement {
  const specification: Specification | null = specificationJson ? JSON.parse(specificationJson) : null;
  return { ...withoutNulls(row, ["notes", "method"]), specification, specificationId: specification?.id ?? null };
}

function toComparison({ alignmentJson, ...row }: ComparisonRow): ImageComparison {
  const alignment: ImageAlignment = JSON.parse(alignmentJson);
  return { ...withoutNulls(row, ["notes"]), alignment };
}

function toSoundResult({ peaksJson, matchesJson, ...row }: SoundResultRow): SoundResult {
  const matches: SoundResult["matches"] = matchesJson ? JSON.parse(matchesJson) : undefined;
  return { ...withoutNulls(row, ["notes"]), peaks: parsePeaks(peaksJson), matches };
}

export class CoinPingDb {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec("PRAGMA trusted_schema = OFF; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      migrateCatalog(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private requiredRow<T>(sql: string, id: number, label: string): T {
    const row = this.db.prepare(sql).get(positiveId(id, label));
    if (!row) throw new ValidationError(`${label} was not found.`);
    return row as T;
  }

  private insertedId(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).lastInsertRowid);
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listReferences(coinId?: number): ReferenceRecord[] {
    const where = coinId === undefined ? "" : "WHERE coin_id = ?";
    const params = coinId === undefined ? [] : [positiveId(coinId, "Coin")];
    const rows = this.db.prepare(`SELECT ${REFERENCE_FIELDS} FROM reference_recordings ${where}
      ORDER BY created_at DESC, id DESC`).all(...params) as ReferenceRow[];
    return rows.map(toReferenceRecord);
  }

  createReference(input: ReferenceInput): ReferenceRecord {
    requireObject(input, "Reference");
    const coinId = input.coinId ?? null;
    this.requireActiveReferenceCoin(coinId);
    const label = requiredText(input.label, "Label");
    const peaks = validPeaks(input.peaks);
    const row = this.db.prepare(`INSERT INTO reference_recordings (label, peaks_json, coin_id)
      VALUES (?, ?, ?) RETURNING ${REFERENCE_FIELDS}`).get(label, JSON.stringify(peaks), coinId) as ReferenceRow;
    return toReferenceRecord(row);
  }

  linkReference(id: number, coinId: number | null): ReferenceRecord {
    positiveId(id, "Reference");
    this.requireActiveReferenceCoin(coinId);
    const row = this.db.prepare(`UPDATE reference_recordings SET coin_id = ? WHERE id = ?
      RETURNING ${REFERENCE_FIELDS}`).get(coinId, id) as ReferenceRow | undefined;
    if (!row) throw new ValidationError("Reference was not found.");
    return toReferenceRecord(row);
  }

  private requireActiveReferenceCoin(coinId: number | null): void {
    if (coinId !== null && this.coinRow(coinId).archived) {
      throw new ValidationError("Restore the archived coin before assigning a reference to it.");
    }
  }

  deleteReference(id: number): void {
    const result = this.db.prepare("DELETE FROM reference_recordings WHERE id = ?").run(positiveId(id, "Reference"));
    if (result.changes === 0) throw new ValidationError("Reference was not found.");
  }

  listCoins(): CoinSummary[] {
    const rows = this.db.prepare(`SELECT ${COIN_FIELDS} FROM coins c ORDER BY c.archived, c.name COLLATE NOCASE, c.id`)
      .all() as CoinRow[];
    return rows.map(toCoin);
  }

  private coinRow(id: number): CoinRow {
    return this.requiredRow<CoinRow>(`SELECT ${COIN_FIELDS} FROM coins c WHERE c.id = ?`, id, "Coin");
  }

  getCoin(id: number): CoinDetail {
    return {
      ...toCoin(this.coinRow(id)),
      specifications: this.listSpecifications(id),
      images: this.listImages(id),
      references: this.listReferences(id),
      sessions: this.listSessions(id),
    };
  }

  createCoin(input: CoinInput): CoinDetail {
    const now = new Date().toISOString();
    const id = this.insertedId(`INSERT INTO coins (name, country, denomination, year_from, year_to,
      mint, variant, composition, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...coinValues(input), now, now);
    return this.getCoin(id);
  }

  updateCoin(id: number, input: CoinInput): CoinDetail {
    this.coinRow(id);
    this.db.prepare(`UPDATE coins SET name = ?, country = ?, denomination = ?, year_from = ?, year_to = ?,
      mint = ?, variant = ?, composition = ?, notes = ?, updated_at = ? WHERE id = ?`)
      .run(...coinValues(input), new Date().toISOString(), id);
    return this.getCoin(id);
  }

  archiveCoin(id: number): void { this.setCoinArchived(id, true); }

  restoreCoin(id: number): void { this.setCoinArchived(id, false); }

  private setCoinArchived(id: number, archived: boolean): void {
    this.coinRow(id);
    this.db.prepare("UPDATE coins SET archived = ?, updated_at = ? WHERE id = ?")
      .run(Number(archived), new Date().toISOString(), id);
  }

  listSpecifications(coinId: number): Specification[] {
    const rows = this.db.prepare(`SELECT ${SPECIFICATION_FIELDS} FROM specifications WHERE coin_id = ? ORDER BY id`)
      .all(positiveId(coinId, "Coin")) as Specification[];
    return rows.map(toSpecification);
  }

  private getSpecification(id: number): Specification {
    return toSpecification(this.requiredRow<Specification>(
      `SELECT ${SPECIFICATION_FIELDS} FROM specifications WHERE id = ?`, id, "Specification",
    ));
  }

  createSpecification(coinId: number, input: SpecificationInput): Specification {
    this.coinRow(coinId);
    const row = this.db.prepare(`INSERT INTO specifications (coin_id, metric, nominal, min, max, source, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${SPECIFICATION_FIELDS}`)
      .get(coinId, ...specificationValues(input)) as Specification;
    return toSpecification(row);
  }

  updateSpecification(id: number, input: SpecificationInput): Specification {
    const row = this.db.prepare(`UPDATE specifications SET metric = ?, nominal = ?, min = ?, max = ?,
      source = ?, notes = ? WHERE id = ? RETURNING ${SPECIFICATION_FIELDS}`)
      .get(...specificationValues(input), positiveId(id, "Specification")) as Specification | undefined;
    if (!row) throw new ValidationError("Specification was not found.");
    return toSpecification(row);
  }

  deleteSpecification(id: number): void {
    const result = this.db.prepare("DELETE FROM specifications WHERE id = ?").run(positiveId(id, "Specification"));
    if (result.changes === 0) throw new ValidationError("Specification was not found.");
  }

  listImages(coinId: number): CoinImage[] {
    const rows = this.db.prepare(`SELECT ${IMAGE_FIELDS} FROM coin_images WHERE coin_id = ? ORDER BY is_primary DESC, id`)
      .all(positiveId(coinId, "Coin")) as ImageRow[];
    return rows.map(toImage);
  }

  private imageRow(id: number): ImageRow {
    return this.requiredRow<ImageRow>(`SELECT ${IMAGE_FIELDS} FROM coin_images WHERE id = ?`, id, "Image");
  }

  getImageAssetKey(id: number): string | null {
    const row = this.db.prepare("SELECT asset_key FROM coin_images WHERE id = ?").get(positiveId(id, "Image"));
    return isAssetKey(row?.asset_key) ? row.asset_key : null;
  }

  addImage(input: ImageImportInput & { assetKey: string; width: number; height: number }): CoinImage {
    requireObject(input, "Image");
    this.coinRow(input.coinId);
    const { coinId, side, assetKey, width, height } = input;
    const role = input.role ?? "reference";
    if (side !== "obverse" && side !== "reverse" && side !== "edge") {
      throw new ValidationError("Choose an image side.");
    }
    if ((role !== "reference" && role !== "candidate") || (role === "candidate" && side === "edge")) {
      throw new ValidationError("Choose a valid image role and side.");
    }
    if (!isAssetKey(assetKey) || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
      throw new ValidationError("Invalid image metadata.");
    }
    const isPrimary = role === "reference" && side !== "edge" && !this.db.prepare(
      "SELECT id FROM coin_images WHERE coin_id = ? AND side = ? AND is_primary = 1",
    ).get(coinId, side);
    const row = this.db.prepare(`INSERT INTO coin_images (coin_id, side, role, is_primary, asset_key, width, height,
      credit, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${IMAGE_FIELDS}`)
      .get(coinId, side, role, Number(isPrimary), assetKey, width, height, optionalText(input.credit, "Credit"),
        optionalText(input.source, "Source"), new Date().toISOString()) as ImageRow;
    return toImage(row);
  }

  setPrimaryImage(id: number): void {
    const image = this.imageRow(id);
    if (image.side === "edge" || image.role !== "reference") {
      throw new ValidationError("Only obverse and reverse reference photos can be primary.");
    }
    this.transaction(() => {
      this.db.prepare("UPDATE coin_images SET is_primary = 0 WHERE coin_id = ? AND side = ? AND is_primary = 1")
        .run(image.coinId, image.side);
      this.db.prepare("UPDATE coin_images SET is_primary = 1 WHERE id = ?").run(id);
    });
  }

  deleteImage(id: number): string {
    const image = this.imageRow(id);
    if (!isAssetKey(image.assetKey)) throw new Error("Invalid catalog image filename.");
    if (this.db.prepare("SELECT id FROM image_comparisons WHERE reference_image_id = ? OR candidate_image_id = ?").get(id, id)) {
      throw new ValidationError("This image is used by a saved comparison.");
    }
    this.transaction(() => {
      this.db.prepare("DELETE FROM coin_images WHERE id = ?").run(id);
      if (image.isPrimary) {
        this.db.prepare(`UPDATE coin_images SET is_primary = 1 WHERE id = (
          SELECT id FROM coin_images WHERE coin_id = ? AND side = ? AND role = 'reference' ORDER BY id LIMIT 1
        )`).run(image.coinId, image.side);
      }
    });
    return image.assetKey;
  }

  private sessionRow(id: number): SessionRow {
    return this.requiredRow<SessionRow>(`SELECT ${SESSION_FIELDS} FROM test_sessions WHERE id = ?`, id, "Test session");
  }

  private toSession(row: SessionRow): Session {
    return {
      ...withoutNulls(row, ["notes"]),
      measurements: (this.db.prepare(`SELECT ${MEASUREMENT_FIELDS} FROM session_measurements
         WHERE session_id = ? ORDER BY measured_at DESC, id DESC`).all(row.id) as MeasurementRow[]).map(toMeasurement),
      comparisons: (this.db.prepare(`SELECT ${COMPARISON_FIELDS} FROM image_comparisons
         WHERE session_id = ? ORDER BY updated_at DESC, id DESC`).all(row.id) as ComparisonRow[]).map(toComparison),
      soundResults: (this.db.prepare(`SELECT ${SOUND_FIELDS} FROM sound_results
         WHERE session_id = ? ORDER BY created_at DESC, id DESC`).all(row.id) as SoundResultRow[]).map(toSoundResult),
    };
  }

  listSessions(coinId: number): Session[] {
    const rows = this.db.prepare(`SELECT ${SESSION_FIELDS} FROM test_sessions
      WHERE coin_id = ? ORDER BY updated_at DESC, id DESC`).all(positiveId(coinId, "Coin")) as SessionRow[];
    return rows.map((row) => this.toSession(row));
  }

  createSession(coinId: number, input: SessionInput): Session {
    this.coinRow(coinId);
    requireObject(input, "Test session");
    const now = new Date().toISOString();
    const row = this.db.prepare(`INSERT INTO test_sessions (coin_id, label, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) RETURNING ${SESSION_FIELDS}`)
      .get(coinId, requiredText(input.label, "Session label"), optionalText(input.notes, "Notes", 10_000), now, now) as SessionRow;
    return this.toSession(row);
  }

  updateSession(id: number, input: SessionInput): Session {
    requireObject(input, "Test session");
    const row = this.db.prepare(`UPDATE test_sessions SET label = ?, notes = ?, updated_at = ? WHERE id = ?
      RETURNING ${SESSION_FIELDS}`).get(requiredText(input.label, "Session label"),
        optionalText(input.notes, "Notes", 10_000), new Date().toISOString(), positiveId(id, "Test session")) as SessionRow | undefined;
    if (!row) throw new ValidationError("Test session was not found.");
    return this.toSession(row);
  }

  private touchSession(id: number): void {
    this.db.prepare("UPDATE test_sessions SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  createMeasurement(sessionId: number, input: MeasurementInput): Measurement {
    const session = this.sessionRow(sessionId);
    requireObject(input, "Measurement");
    const metric = validMetric(input.metric);
    const value = metricValue(metric, input.value, "Measurement");
    const specification = input.specificationId == null ? null : this.getSpecification(input.specificationId);
    if (specification && (specification.coinId !== session.coinId || specification.metric !== metric)) {
      throw new ValidationError("Choose a specification for this coin and measurement type.");
    }
    let status: MeasurementStatus = "not-assessed";
    if (specification && (specification.min !== undefined || specification.max !== undefined)) {
      const below = specification.min !== undefined && value < specification.min;
      const above = specification.max !== undefined && value > specification.max;
      status = below || above ? "outside" : "within";
    }
    return this.transaction(() => {
      const row = this.db.prepare(`INSERT INTO session_measurements (session_id, metric, value,
        specification_json, status, method, notes, measured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${MEASUREMENT_FIELDS}`)
        .get(sessionId, metric, value, specification ? JSON.stringify(specification) : null, status,
          optionalText(input.method, "Method"), optionalText(input.notes, "Notes", 10_000), validTimestamp(input.measuredAt)) as MeasurementRow;
      this.touchSession(sessionId);
      return toMeasurement(row);
    });
  }

  private comparisonValues(session: SessionRow, input: ComparisonInput): SQLInputValue[] {
    const alignment = comparisonAlignment(input);
    const reference = this.imageRow(input.referenceImageId);
    const candidate = this.imageRow(input.candidateImageId);
    if ((input.side !== "obverse" && input.side !== "reverse") || reference.side !== input.side ||
        candidate.side !== input.side || reference.coinId !== session.coinId || candidate.coinId !== session.coinId ||
        reference.role !== "reference" || candidate.role !== "candidate") {
      throw new ValidationError("Choose reference and candidate photos of the same coin face.");
    }
    return [input.side, reference.id, candidate.id, JSON.stringify(alignment), optionalText(input.notes, "Notes", 10_000)];
  }

  createComparison(sessionId: number, input: ComparisonInput): ImageComparison {
    const values = this.comparisonValues(this.sessionRow(sessionId), input);
    const now = new Date().toISOString();
    return this.transaction(() => {
      const row = this.db.prepare(`INSERT INTO image_comparisons (session_id, side, reference_image_id,
        candidate_image_id, alignment_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING ${COMPARISON_FIELDS}`).get(sessionId, ...values, now, now) as ComparisonRow;
      this.touchSession(sessionId);
      return toComparison(row);
    });
  }

  updateComparison(id: number, input: ComparisonInput): ImageComparison {
    const previous = this.requiredRow<ComparisonRow>(
      `SELECT ${COMPARISON_FIELDS} FROM image_comparisons WHERE id = ?`, id, "Image comparison",
    );
    const values = this.comparisonValues(this.sessionRow(previous.sessionId), input);
    return this.transaction(() => {
      const row = this.db.prepare(`UPDATE image_comparisons SET side = ?, reference_image_id = ?, candidate_image_id = ?,
        alignment_json = ?, notes = ?, updated_at = ? WHERE id = ? RETURNING ${COMPARISON_FIELDS}`)
        .get(...values, new Date().toISOString(), id) as ComparisonRow;
      this.touchSession(previous.sessionId);
      return toComparison(row);
    });
  }

  saveSoundResult(sessionId: number, input: SoundResultInput): SoundResult {
    this.sessionRow(sessionId);
    requireObject(input, "Sound result");
    const peaks = validPeaks(input.peaks);
    if (input.matches !== undefined && !Array.isArray(input.matches)) {
      throw new ValidationError("Invalid sound matches.");
    }
    const matches = input.matches?.map((match) => {
      requireObject(match, "Sound match");
      if (!Number.isFinite(match.score) || match.score < 0 || match.score > 1) {
        throw new ValidationError("Match score must be between 0 and 1.");
      }
      // The snapshot can combine a coin name with a reference title, including
      // older titles saved before the limit on each newly entered name.
      if (typeof match.label !== "string" || !match.label.trim()) {
        throw new ValidationError("Match label is required.");
      }
      return { referenceId: positiveId(match.referenceId, "Reference"), label: match.label.trim(), score: match.score };
    });
    return this.transaction(() => {
      const row = this.db.prepare(`INSERT INTO sound_results (session_id, label, peaks_json, matches_json, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING ${SOUND_FIELDS}`).get(sessionId, requiredText(input.label, "Sound result label"),
          JSON.stringify(peaks), matches ? JSON.stringify(matches) : null, optionalText(input.notes, "Notes", 10_000),
          new Date().toISOString()) as SoundResultRow;
      this.touchSession(sessionId);
      return toSoundResult(row);
    });
  }

  async backupTo(path: string): Promise<void> {
    await backup(this.db, path);
  }

  static validateBackup(path: string): string[] {
    const db = new DatabaseSync(path, { readOnly: true });
    const canonical = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA trusted_schema = OFF;");
      const integrity = db.prepare("PRAGMA quick_check").all();
      if (schemaVersion(db) !== CATALOG_SCHEMA_VERSION || integrity.length !== 1 || integrity[0].quick_check !== "ok") {
        throw new ValidationError("This file is not a supported catalog backup.");
      }
      migrateCatalog(canonical);
      // SQLite preserves the original SQL formatting when it adds coin_id to
      // a legacy table. Compare SQL tokens rather than whitespace around them.
      const sqlTokens = (sql: string) =>
        (sql.match(/"(?:""|[^"])*"|'(?:''|[^'])*'|[A-Za-z_]\w*|\d+(?:\.\d+)?|[^\s]/g) ?? [])
          .map((token) => /^[A-Za-z_]/.test(token) ? token.toLowerCase() : token);
      const readSchema = (source: DatabaseSync) => source.prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name",
      ).all().map(({ type, name, sql }) => [type, name, sqlTokens(String(sql))]);
      if (JSON.stringify(readSchema(db)) !== JSON.stringify(readSchema(canonical)) ||
          db.prepare("PRAGMA foreign_key_check").get()) {
        throw new ValidationError("The catalog backup contains an unexpected database structure.");
      }
      const invalidJson = db.prepare(`
        WITH documents(value, expected_type) AS (
          SELECT peaks_json, 'array' FROM reference_recordings
          UNION ALL SELECT peaks_json, 'array' FROM sound_results
          UNION ALL SELECT matches_json, 'array' FROM sound_results WHERE matches_json IS NOT NULL
          UNION ALL SELECT specification_json, 'object' FROM session_measurements WHERE specification_json IS NOT NULL
          UNION ALL SELECT alignment_json, 'object' FROM image_comparisons
        )
        SELECT 1 FROM documents
        WHERE json_type(CASE WHEN json_valid(value) THEN value ELSE 'null' END) <> expected_type
        LIMIT 1
      `).get();
      if (invalidJson) throw new ValidationError("The backup contains invalid catalog records.");

      return db.prepare("SELECT asset_key FROM coin_images ORDER BY id").all().map((row) => {
        if (!isAssetKey(row.asset_key)) throw new ValidationError("The backup contains an invalid image filename.");
        return row.asset_key;
      });
    } finally {
      canonical.close();
      db.close();
    }
  }

  checkpointAndClose(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
    if (this.closed) return;
    this.db.exec(`PRAGMA wal_checkpoint(${mode});`);
    this.db.close();
    this.closed = true;
  }
}
