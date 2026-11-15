import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { nativeImage } from "electron";

import type { ImageImportInput } from "../src/types/catalog.js";
import { isAssetKey } from "../src-electron/db/catalogValidation.js";
import { CoinPingDb } from "../src-electron/db/coinPingDb.js";

export const DATABASE_NAME = "coin-ping-test.sqlite";
const MEDIA_DIR = "coin-media";
const POINTER_NAME = "active-coin-library";
const BACKUP_MARKER = "coin-library-backup.json";
const BACKUP_CONTENTS = { format: "coin-ping-library", version: 1 };
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const libraryIdPattern = new RegExp(`^${UUID}$`);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 45_000_000;

function mediaPath(base: string, assetKey: string, thumbnail = false): string {
  if (!isAssetKey(assetKey)) throw new Error("Invalid image identifier.");
  return path.join(base, MEDIA_DIR, thumbnail ? `${assetKey}.thumb.jpg` : assetKey);
}

function getImageExtension(bytes: Buffer): "jpg" | "png" {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  throw new Error("Choose a JPEG or PNG photo.");
}

async function regularFile(file: string): Promise<void> {
  if (!(await lstat(file)).isFile()) throw new Error("A required backup file is invalid.");
}

async function copyLibraryImages(source: string, target: string, keys: string[]) {
  await mkdir(path.join(target, MEDIA_DIR), { recursive: true });
  if (keys.length === 0) return;
  if (!(await lstat(path.join(source, MEDIA_DIR))).isDirectory()) {
    throw new Error("The backup image folder is invalid.");
  }
  for (const key of keys) {
    for (const thumbnail of [false, true]) {
      const src = mediaPath(source, key, thumbnail);
      await regularFile(src);
      await copyFile(src, mediaPath(target, key, thumbnail));
    }
  }
}

export class CatalogFiles {
  private constructor(private readonly userData: string, private activeDirectory: string) {}

  static async open(userData: string): Promise<CatalogFiles> {
    try {
      const active = (await readFile(path.join(userData, POINTER_NAME), "utf8")).trim();
      if (!libraryIdPattern.test(active)) throw new Error("The active coin library identifier is invalid.");
      const directory = path.join(userData, "coin-libraries", active);
      await regularFile(path.join(directory, DATABASE_NAME));
      return new CatalogFiles(userData, directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // An installation without a pointer still uses the original database path.
      const pointerExists = await lstat(path.join(userData, POINTER_NAME)).then(
        () => true,
        (failure: NodeJS.ErrnoException) => {
          if (failure.code === "ENOENT") return false;
          throw failure;
        },
      );
      if (pointerExists) throw new Error("The active coin library is missing.");
      return new CatalogFiles(userData, userData);
    }
  }

  get databasePath(): string {
    return path.join(this.activeDirectory, DATABASE_NAME);
  }

  async importPhoto(db: CoinPingDb, file: string, input: ImageImportInput) {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) {
      throw new Error("Choose a JPEG or PNG photo up to 25 MB.");
    }
    const bytes = await readFile(file);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Choose a photo up to 25 MB.");
    const extension = getImageExtension(bytes);
    const decoded = nativeImage.createFromBuffer(bytes);
    const { width, height } = decoded.getSize();
    if (decoded.isEmpty() || !width || !height || width * height > MAX_IMAGE_PIXELS) {
      throw new Error("The photo could not be opened or exceeds 45 megapixels.");
    }
    const thumbnail = decoded.resize(width >= height
      ? { width: Math.min(width, 360), quality: "good" }
      : { height: Math.min(height, 360), quality: "good" });
    const assetKey = `${randomUUID()}.${extension}`;
    const original = mediaPath(this.activeDirectory, assetKey);
    const preview = mediaPath(this.activeDirectory, assetKey, true);
    await mkdir(path.dirname(original), { recursive: true });
    try {
      await writeFile(original, bytes, { flag: "wx" });
      await writeFile(preview, thumbnail.toJPEG(85), { flag: "wx" });
      return db.addImage({ ...input, assetKey, width, height });
    } catch (error) {
      await Promise.allSettled([rm(original, { force: true }), rm(preview, { force: true })]);
      throw error;
    }
  }

  async removePhoto(db: CoinPingDb, id: number) {
    const key = db.deleteImage(id);
    const results = await Promise.allSettled([
      rm(mediaPath(this.activeDirectory, key), { force: true }),
      rm(mediaPath(this.activeDirectory, key, true), { force: true }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("Could not remove an unused photo:", result.reason);
    }
  }

  async servePhoto(db: CoinPingDb, url: string): Promise<Response> {
    const request = new URL(url);
    const id = Number(request.pathname.slice(1));
    if (request.hostname !== "image" || !/^\/\d+$/.test(request.pathname) || !Number.isSafeInteger(id) || id < 1) {
      return new Response(null, { status: 404 });
    }
    const key = db.getImageAssetKey(id);
    if (!key) return new Response(null, { status: 404 });
    const thumbnail = request.searchParams.get("variant") === "thumb";
    try {
      const bytes = await readFile(mediaPath(this.activeDirectory, key, thumbnail));
      return new Response(bytes, {
        headers: {
          "Content-Type": thumbnail || key.endsWith(".jpg") ? "image/jpeg" : "image/png",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  }

  async exportBackup(db: CoinPingDb, destination: string) {
    const staging = await mkdtemp(path.join(destination, ".coin-library-backup-"));
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(destination, `Coin Library ${suffix}-${randomUUID().slice(0, 8)}`);
    try {
      const snapshot = path.join(staging, DATABASE_NAME);
      await db.backupTo(snapshot);
      await copyLibraryImages(this.activeDirectory, staging, CoinPingDb.validateBackup(snapshot));
      await writeFile(path.join(staging, BACKUP_MARKER), JSON.stringify(BACKUP_CONTENTS));
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async restoreBackup(source: string): Promise<CoinPingDb> {
    const marker = path.join(source, BACKUP_MARKER);
    await regularFile(marker);
    const metadata = JSON.parse(await readFile(marker, "utf8"));
    if (metadata?.format !== BACKUP_CONTENTS.format || metadata?.version !== BACKUP_CONTENTS.version) {
      throw new Error("Select a Coin Library backup folder made by this app.");
    }
    const sourceDb = path.join(source, DATABASE_NAME);
    await regularFile(sourceDb);
    const id = randomUUID();
    const target = path.join(this.userData, "coin-libraries", id);
    const pointer = path.join(this.userData, `.${POINTER_NAME}-${id}`);
    let newDb: CoinPingDb | undefined;
    try {
      await mkdir(target, { recursive: true });
      const databasePath = path.join(target, DATABASE_NAME);
      await copyFile(sourceDb, databasePath);
      const keys = CoinPingDb.validateBackup(databasePath);
      await copyLibraryImages(source, target, keys);
      newDb = new CoinPingDb(databasePath);
      await writeFile(pointer, id, { flag: "wx" });
      await rename(pointer, path.join(this.userData, POINTER_NAME));
      this.activeDirectory = target;
      return newDb;
    } catch (error) {
      try {
        newDb?.checkpointAndClose("TRUNCATE");
      } finally {
        await Promise.allSettled([
          rm(pointer, { force: true }),
          rm(target, { force: true, recursive: true }),
        ]);
      }
      throw error;
    }
  }
}
