const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createLoader, createHookRunner, deferred } = require("./helpers.cjs");

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== "object") return undefined;
  return predicate(node) ? node : find(node.props?.children, predicate);
}

function setup() {
  const runner = createHookRunner();
  const sqlrooms = Object.fromEntries([
    "Button", "Dialog", "DialogContent", "DialogDescription", "DialogFooter", "DialogHeader", "DialogTitle",
  ].map((name) => [name, name]));
  const load = createLoader({
    react: runner.react,
    "@sqlrooms/ui": sqlrooms,
    "./components/CoinCatalog": { CoinCatalog: "CoinCatalog", CoinDetails: "CoinDetails" },
    "./components/ImageComparison": { ImageComparison: "ImageComparison" },
    "./components/SoundWorkspace": { SoundWorkspace: "SoundWorkspace" },
  }, {
    window: {
      coinCatalogApi: { listCoins: async () => [] },
      coinPingApi: { listReferences: async () => [] },
    },
  });
  const App = load("src/App.tsx").default;
  runner.render(App);
  return {
    render: () => runner.render(),
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
