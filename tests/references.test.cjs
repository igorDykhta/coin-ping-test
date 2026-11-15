const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createLoader, createHookRunner } = require("./helpers.cjs");

function findElement(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

function createSaveDialog({ coins, selectedCoinId, onCreateCoin, createReference }) {
  const listRunner = createHookRunner();
  const ui = Object.fromEntries([
    "Button", "Dialog", "DialogClose", "DialogContent", "DialogDescription",
    "DialogFooter", "DialogHeader", "DialogTitle",
  ].map((name) => [name, name]));
  const { DetectedPingsList } = createLoader({ react: listRunner.react, "@sqlrooms/ui": ui }, {
    window: { coinPingApi: { createReference } },
  })("src/components/DetectedPingsList.tsx");
  const ping = {
    id: "ping-test", detectedAt: "2026-01-01", peaks: [{ frequencyHz: 5000, magnitude: -20 }],
    topPeakSustainMs: 300,
  };
  const props = { pings: [ping], enabled: true, coins, selectedCoinId, onCreateCoin };
  const tree = listRunner.render(() => DetectedPingsList(props));
  findElement(tree, (el) => el.type?.name === "DetectedPingItem").props.onRequestSave(ping);
  const dialog = findElement(listRunner.render(), (el) => el.type?.name === "SavePingDialog");
  const dialogRunner = createHookRunner();
  Object.assign(listRunner.react, dialogRunner.react);
  return {
    render(updated = {}) {
      return dialogRunner.render(() => dialog.type({ ...dialog.props, ...updated }));
    },
    select(tree) {
      return findElement(tree, (el) => el.props.id === "save-ping-coin");
    },
    async save(tree) {
      findElement(tree, (el) => el.type === "Button" && el.props.children === "Save").props.onClick();
      await new Promise(setImmediate);
    },
  };
}

test("saving through the dialog preserves metadata and matches the same ping", async () => {
  const runner = createHookRunner();
  const ui = Object.fromEntries([
    "Button", "Dialog", "DialogClose", "DialogContent", "DialogDescription",
    "DialogFooter", "DialogHeader", "DialogTitle",
  ].map((name) => [name, name]));
  let saved;
  const load = createLoader({ react: runner.react, "@sqlrooms/ui": ui }, {
    window: { coinPingApi: { async createReference(input) {
      saved = { ...JSON.parse(JSON.stringify(input)), id: 1, createdAt: "2026-01-01" };
      return saved;
    } } },
  });
  const { DetectedPingsList } = load("src/components/DetectedPingsList.tsx");
  const { findMatchingReferences } = load("src/lib/coinMatcher.ts");
  const peaks = [
    { frequencyHz: 5000, magnitude: -20, kind: "long", sustainMs: 300, accumulatedPowerDb: -30 },
    { frequencyHz: 7000, magnitude: -25, kind: "short", sustainMs: 150 },
    { frequencyHz: 9000, magnitude: -30, kind: "short", sustainMs: 150 },
  ];
  const ping = { id: "ping-test", detectedAt: "2026-01-01", peaks, topPeakSustainMs: 300 };
  let tree = runner.render(() => DetectedPingsList({ pings: [ping], enabled: true }));
  findElement(tree, (el) => el.type?.name === "DetectedPingItem").props.onRequestSave(ping);
  tree = runner.render();
  const dialog = findElement(tree, (el) => el.type?.name === "SavePingDialog");
  // The dialog has its own hook state, just as it does in React.
  runner.unmount();
  const dialogRunner = createHookRunner();
  Object.assign(runner.react, dialogRunner.react);
  const dialogTree = dialogRunner.render(() => dialog.type(dialog.props));
  const save = findElement(dialogTree, (el) => el.type === "Button" && el.props.children === "Save");
  assert.equal(save.props.disabled, false);
  await save.props.onClick();
  assert.deepEqual(saved.peaks, peaks);
  const [match] = findMatchingReferences(peaks, [saved]);
  assert.equal(match.score, 1);
  assert.equal(match.matchedRefPeakCount, 1);
  assert.equal(match.comparedRefPeakCount, 1);
});

test("legacy references without classification still match", () => {
  const { findMatchingReferences } = createLoader()("src/lib/coinMatcher.ts");
  const peaks = [{ frequencyHz: 5000, magnitude: -20 }, { frequencyHz: 7000, magnitude: -25 }];
  const reference = { id: 1, label: "Legacy", createdAt: "2026-01-01", peaks };
  const [match] = findMatchingReferences(peaks, [reference]);
  assert.equal(match.score, 1);
  assert.equal(match.comparedRefPeakCount, 2);
});

test("archiving the selected coin cannot attach a reference to it from the save dialog", async () => {
  let saved;
  const activeCoin = { id: 21, name: "Coin A", archived: false };
  const dialog = createSaveDialog({
    coins: [activeCoin], selectedCoinId: activeCoin.id, createReference(input) { saved = input; },
  });
  assert.equal(dialog.select(dialog.render()).props.value, "21");

  const archivedCoin = { ...activeCoin, archived: true };
  const tree = dialog.render({ coins: [archivedCoin] });
  assert.equal(dialog.select(tree).props.value, "");
  await dialog.save(tree);
  assert.equal(saved.coinId, null);
});

test("retrying a reference save keeps the just-created coin before the catalog refreshes", async () => {
  let creations = 0;
  const saved = [];
  const dialog = createSaveDialog({
    coins: [],
    async onCreateCoin() { creations++; return 42; },
    async createReference(input) {
      saved.push(input);
      if (saved.length === 1) throw new Error("Retry this reference");
    },
  });
  dialog.select(dialog.render()).props.onChange({ target: { value: "new" } });
  const newCoinField = findElement(dialog.render(), (el) => el.props["aria-label"] === "New coin name");
  newCoinField.props.onChange({ target: { value: "New coin" } });
  await dialog.save(dialog.render());
  assert.equal(dialog.select(dialog.render()).props.value, "42");
  await dialog.save(dialog.render());
  assert.equal(creations, 1);
  assert.deepEqual(saved.map(({ coinId }) => coinId), [42, 42]);
});

test("saving a sound result does not mark it saved in a different session", async () => {
  const listRunner = createHookRunner();
  const { DetectedPingsList } = createLoader({
    react: listRunner.react, "@sqlrooms/ui": { Button: "Button" },
  })("src/components/DetectedPingsList.tsx");
  const ping = {
    id: "one-take", detectedAt: "2026-01-01", peaks: [{ frequencyHz: 5000, magnitude: -20 }],
    triggerBandDb: -25, baselineBandDb: -70, topPeakSustainMs: 300,
  };
  const savedTo = [];
  const first = "1:21", second = "1:22";
  const tree = listRunner.render(() => DetectedPingsList({
    pings: [ping], enabled: true,
    resultDestination: first, onSaveResult: async () => { savedTo.push(first); },
  }));
  const item = findElement(tree, (el) => el.type?.name === "DetectedPingItem");
  const runner = createHookRunner();
  Object.assign(listRunner.react, runner.react);
  function resultButton(destination) {
    const rendered = runner.render(() => item.type({
      ...item.props,
      resultDestination: destination,
      onSaveResult: async () => { savedTo.push(destination); },
    }));
    return findElement(rendered, (el) => el.type === "Button" && /test result/i.test(el.props.children)).props;
  }
  resultButton(first).onClick();
  await new Promise(setImmediate);
  assert.deepEqual(savedTo, [first]);
  assert.equal(resultButton(first).disabled, true);
  assert.equal(resultButton(second).disabled, false);
  assert.equal(resultButton(first).disabled, true);
});
