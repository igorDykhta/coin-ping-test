const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createLoader } = require("./helpers.cjs");

let sqliteAvailable = true;
try {
  require("node:sqlite");
} catch (error) {
  if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
  sqliteAvailable = false;
}

test("backup restores the database and managed photos together", {
  skip: !sqliteAvailable && "This shell Node runtime has no node:sqlite.",
}, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "coin-media-test-"));
  const photo = Buffer.from([255, 216, 255, 33]);
  const thumb = Buffer.from([255, 216, 255, 44]);
  const load = createLoader({
    electron: { nativeImage: { createFromBuffer: () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 500, height: 500 }),
      resize: () => ({ toJPEG: () => thumb }),
    }) } },
  });
  const { CatalogFiles } = load("electron/catalogFiles.ts");
  const { CoinPingDb } = load("src-electron/db/coinPingDb.ts");
  const library = await CatalogFiles.open(temp);
  const db = new CoinPingDb(library.databasePath);
  let restored;
  t.after(async () => {
    restored?.checkpointAndClose();
    db.checkpointAndClose();
    await fs.rm(temp, { recursive: true, force: true });
  });

  const coin = db.createCoin({ name: "Silver Crown" });
  const original = path.join(temp, "input.jpg");
  await fs.writeFile(original, photo);
  const image = await library.importPhoto(db, original, { coinId: coin.id, side: "obverse" });
  await fs.unlink(original);
  const url = `coin-media://image/${image.id}`;

  const output = path.join(temp, "exports");
  await fs.mkdir(output);
  await library.exportBackup(db, output);
  const [folder] = await fs.readdir(output);
  const backup = path.join(output, folder);
  db.updateCoin(coin.id, { name: "Later change" });

  restored = await library.restoreBackup(backup);
  assert.equal(restored.getCoin(coin.id).name, "Silver Crown");
  assert.equal(db.getCoin(coin.id).name, "Later change");
  assert.equal((await CatalogFiles.open(temp)).databasePath, library.databasePath);
  assert.deepEqual(Buffer.from(await (await library.servePhoto(restored, url)).arrayBuffer()), photo);
  assert.deepEqual(Buffer.from(await (await library.servePhoto(restored, url + "?variant=thumb")).arrayBuffer()), thumb);

  await fs.rm(path.join(backup, "coin-media"), { recursive: true });
  await assert.rejects(() => library.restoreBackup(backup));
  assert.equal((await CatalogFiles.open(temp)).databasePath, library.databasePath);
  assert.equal(restored.getCoin(coin.id).images[0].id, image.id);
});
