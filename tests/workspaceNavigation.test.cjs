const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createLoader, createHookRunner, deferred } = require("./helpers.cjs");

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== "object") return undefined;
  return predicate(node) ? node : find(node.props?.children, predicate);
}

function setup(coinCatalogApi = {}) {
  const runner = createHookRunner();
  let workspaceRunner = createHookRunner();
  let workspaceKey;
  let activeRunner = runner;
  const react = Object.fromEntries(Object.keys(runner.react).map((name) => [
    name, (...args) => activeRunner.react[name](...args),
  ]));
  const sqlrooms = Object.fromEntries([
    "Button", "Dialog", "DialogContent", "DialogDescription", "DialogFooter", "DialogHeader", "DialogTitle",
  ].map((name) => [name, name]));
  const load = createLoader({
    react,
    "@sqlrooms/ui": sqlrooms,
    "./components/CoinCatalog": { CoinCatalog: "CoinCatalog", CoinDetails: "CoinDetails" },
    "./components/ImageComparison": { ImageComparison: "ImageComparison" },
    "./components/SoundWorkspace": { SoundWorkspace: "SoundWorkspace" },
  }, {
    window: {
      coinCatalogApi: { listCoins: async () => [], ...coinCatalogApi },
      coinPingApi: { listReferences: async () => [] },
    },
  });
  const App = load("src/App.tsx").default;
  runner.render(App);
  function component(name) {
    return find(runner.render(), (el) => el.type === name || el.type?.name === name);
  }
  return {
    render: () => runner.render(),
    component,
    imageComparison() {
      const workspace = component("CoinPhotoWorkspace");
      if (workspace.key !== workspaceKey) {
        workspaceKey = workspace.key;
        workspaceRunner = createHookRunner();
      }
      activeRunner = workspaceRunner;
      try {
        return workspaceRunner.render(() => workspace.type(workspace.props)).props;
      } finally {
        activeRunner = runner;
      }
    },
    click(label) {
      const button = find(runner.render(), (el) => el.type === "Button" && el.props.children === label);
      assert.ok(button, `Expected button ${label}`);
      button.props.onClick();
    },
    soundControls: (controls) => {
      find(runner.render(), (el) => el.type === "SoundWorkspace").props.onSoundControlsChange(controls);
    },
    tab: (label) => find(runner.render(), (el) => el.type === "Button" && el.props.children === label).props["aria-current"],
    navigationDialog: () => find(runner.render(), (el) => el.type === "Dialog").props.open,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const coin = (id, extra = {}) => ({ id, name: `Coin ${id}`, images: [], sessions: [], ...extra });
const candidate = (id) => ({ id, side: "obverse", name: `Candidate ${id}`, url: "" });
const draft = (candidateId, referenceImageId = 1) => ({
  side: "obverse", referenceImageId, candidate: candidate(candidateId), alignment: {}, notes: "",
});

async function openCoin(app, id) {
  app.component("CoinCatalog").props.onSelect(id);
  await flush();
  return app.component("CoinDetails").props;
}

test("switching away from the sound workspace stops capture before changing tabs", async () => {
  const app = setup();
  await flush();
  app.click("Sound analysis");
  const stopped = deferred();
  app.soundControls({
    isRecording: false,
    finishRecording: async () => { assert.fail("There is no recording to finish"); },
    stopListening: () => stopped.promise,
  });
  app.click("Image comparison");
  assert.equal(app.tab("Sound analysis"), "page");
  stopped.resolve();
  await flush();
  assert.equal(app.tab("Image comparison"), "page");
});

test("finishing a recording keeps the sound workspace until analysis and cleanup complete", async () => {
  const app = setup();
  await flush();
  app.click("Sound analysis");
  const analyzed = deferred();
  const actions = [];
  app.soundControls({
    isRecording: true,
    finishRecording: () => {
      actions.push("finish");
      return analyzed.promise;
    },
    stopListening: async () => { actions.push("stop"); },
  });
  app.click("Catalog");
  assert.equal(app.navigationDialog(), true);
  app.click("Stay");
  assert.deepEqual(actions, []);
  assert.equal(app.tab("Sound analysis"), "page");

  app.click("Catalog");
  app.click("Finish recording");
  assert.deepEqual(actions, ["finish"]);
  assert.equal(app.tab("Sound analysis"), "page");
  analyzed.resolve();
  await flush();
  assert.deepEqual(actions, ["finish", "stop"]);
  assert.equal(app.tab("Catalog"), "page");
});

test("different photo pairs get separate history entries and edits update the original pair", async () => {
  const writes = [];
  let nextId = 50;
  const app = setup({
    getCoin: async (id) => coin(id),
    createComparison: async (sessionId, input) => {
      writes.push(["create", sessionId, input.referenceImageId, input.candidateImageId]);
      return { id: nextId++ };
    },
    updateComparison: async (id, input) => {
      writes.push(["update", id, input.referenceImageId, input.candidateImageId]);
      return { id };
    },
  });
  await flush();
  (await openCoin(app, 7)).onCompare("obverse", { sessionId: 21 });
  const comparison = app.imageComparison();
  await comparison.onSave(draft(11));
  await comparison.onSave(draft(12));
  await comparison.onSave(draft(11, 2));
  await comparison.onSave({ ...draft(11), notes: "Inspect the rim" });
  assert.deepEqual(writes, [
    ["create", 21, 1, 11], ["create", 21, 1, 12], ["create", 21, 2, 11], ["update", 50, 1, 11],
  ]);
});

test("a named test session is shared when switching directly between photo and sound modes", async () => {
  const writes = [];
  const session = { id: 123, label: "Reference specimen test" };
  const app = setup({
    getCoin: async (id) => coin(id, { sessions: [session] }),
    createSession: async () => assert.fail("The active session should be reused"),
    createComparison: async (sessionId) => { writes.push(["photo", sessionId]); return { id: 54 }; },
    saveSoundResult: async (sessionId) => { writes.push(["sound", sessionId]); },
  });
  await flush();
  (await openCoin(app, 7)).onCompare("obverse", { sessionId: session.id });
  app.click("Sound analysis");
  const sound = app.component("SoundWorkspace").props;
  assert.equal(sound.sessionId, session.id);
  await sound.onSaveResult({ detectedAt: "2026-01-01T00:00:00Z", peaks: [] }, []);
  app.click("Image comparison");
  await flush();
  assert.equal(app.tab("Image comparison"), "page");
  await app.imageComparison().onSave(draft(11));
  assert.deepEqual(writes, [["sound", 123], ["photo", 123]]);
});

test("a late refresh for a previous coin leaves the current detail request intact", async () => {
  const pendingCoin = deferred();
  const requested = [];
  const app = setup({ getCoin: async (id) => {
    requested.push(id);
    return id === 2 ? pendingCoin.promise : coin(id);
  } });
  await flush();
  const previous = await openCoin(app, 1);
  previous.onBack();
  app.component("CoinCatalog").props.onSelect(2);
  await previous.onChanged();
  pendingCoin.resolve(coin(2));
  await flush();
  assert.deepEqual(requested, [1, 2]);
  assert.equal(app.component("CoinDetails").props.coin.id, 2);
});

test("Sound Analysis does not use the archived coin displayed in the catalog", async () => {
  const app = setup({ getCoin: async (id) => coin(id, { archived: true }) });
  await flush();
  await openCoin(app, 7);
  app.click("Sound analysis");
  const sound = app.component("SoundWorkspace").props;
  assert.equal(sound.coinId, null);
  await assert.rejects(() => sound.onSaveResult({}, []), /Select an active catalog coin/);
});
