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
