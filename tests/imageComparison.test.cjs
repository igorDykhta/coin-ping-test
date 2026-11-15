const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHookRunner, createLoader } = require("./helpers.cjs");

const obverse = { id: 1, side: "obverse", name: "Front", url: "coin-media://1", primary: true };
const reverse = { id: 2, side: "reverse", name: "Back", url: "coin-media://2", primary: true };
const candidate = { id: 3, side: "obverse", name: "Sample", url: "coin-media://3" };

function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

function comparisonHarness(overrides = {}) {
  const runner = createHookRunner();
  const load = createLoader({
    react: runner.react,
    "@sqlrooms/ui": { Button: "button", Input: "input", Label: "label" },
    "./ImageComparison.css": {},
  }, {
    window: { confirm: () => true },
  });
  const { ImageComparison } = load("src/components/ImageComparison.tsx");
  const drafts = [];
  let props = {
    coinName: "Test coin",
    referenceImages: [obverse, reverse],
    candidateImages: [candidate],
    async importCandidate() { return null; },
    async onSave(draft) { drafts.push(draft); },
    ...overrides,
  };
  let tree;
  function render(next) {
    props = { ...props, ...next };
    tree = runner.render(() => ImageComparison(props));
  }
  render();
  return {
    render,
    drafts,
    button(label) {
      return find(tree, (node) => node.type === "button" && node.props.children === label).props;
    },
    pane() {
      return find(tree, (node) => node.type?.name === "ComparisonPane").props;
    },
    field(label) {
      return find(tree, (node) => node.type?.name === "NumberField" && node.props.label === label).props;
    },
    error() {
      return find(tree, (node) => node.props.role === "alert")?.props.children;
    },
    candidateOption(id) {
      return find(tree, (node) => node.type === "option" && node.props.value === id);
    },
    selectCandidate(id) {
      const label = find(tree, (node) => node.type === "label" && node.props.children[0]?.props?.children === "Candidate photo");
      const select = find(label, (node) => node.type === "select");
      select.props.onChange({ currentTarget: { value: String(id) } });
      render();
    },
  };
}

test("reopening continues the saved alignment and keeps each face's draft", () => {
  const { INITIAL_ALIGNMENT } = createLoader()("src/lib/imageAlignment.ts");
  const initial = {
    side: "obverse",
    referenceImageId: obverse.id,
    candidate,
    alignment: {
      ...INITIAL_ALIGNMENT,
      candidate: { x: -0.12, y: 0.05, rotation: 17, scale: 1.5 },
      zoom: 2,
      pan: { x: 0.09, y: 0.04 },
      opacity: 0.23,
    },
    notes: "Compare rim and lettering",
  };
  const app = comparisonHarness({ initial });
  assert.deepEqual(app.pane().alignment, initial.alignment);
  assert.equal(app.button("Save comparison").disabled, true);
  app.field("Rotation (°)").onCommit(-41);
  app.render({ requestedSide: { side: "reverse", requestId: 1 } });
  assert.equal(app.pane().photos.reference.id, reverse.id);
  app.render({ requestedSide: { side: "obverse", requestId: 2 } });
  assert.equal(app.pane().photos.reference.id, obverse.id);
  assert.equal(app.pane().alignment.candidate.rotation, -41);
  assert.equal(app.button("Save comparison").disabled, false);
  app.button("Undo").onClick();
  app.render();
  assert.deepEqual(app.pane().alignment, initial.alignment);
});

test("saving reuses the selected candidate and submits aligned layers and photo IDs", async () => {
  const app = comparisonHarness();
  app.selectCandidate(candidate.id);
  assert.equal(app.pane().photos.candidate.id, candidate.id);
  app.field("Scale (%)").onCommit(142);
  app.render();
  app.button("Reference").onClick();
  app.render();
  assert.equal(app.field("Rotation (°)").disabled, true);
  assert.equal(app.pane().alignment.candidate.scale, 1.42);
  app.button("Save comparison").onClick();
  await Promise.resolve();
  app.render();
  assert.equal(app.drafts.length, 1);
  assert.equal(app.drafts[0].side, "obverse");
  assert.equal(app.drafts[0].referenceImageId, obverse.id);
  assert.equal(app.drafts[0].candidate.id, candidate.id);
  assert.equal(app.drafts[0].alignment.candidate.scale, 1.42);
  assert.equal(app.drafts[0].alignment.reference.scale, 1);
  assert.equal(app.button("Save comparison").disabled, true);
});

test("a saved comparison keeps the reference used at save time when the primary changes", async () => {
  const replacement = { ...obverse, id: 4, name: "New primary", primary: false };
  const app = comparisonHarness({ referenceImages: [obverse, replacement, reverse] });
  app.selectCandidate(candidate.id);
  app.button("Save comparison").onClick();
  await Promise.resolve();
  app.render({
    referenceImages: [{ ...obverse, primary: false }, { ...replacement, primary: true }, reverse],
  });

  assert.equal(app.drafts[0].referenceImageId, obverse.id);
  assert.equal(app.pane().photos.reference.id, obverse.id);
  assert.equal(app.button("Save comparison").disabled, true);
});

test("removing an unused candidate clears the workspace and excludes it from stale lists", async () => {
  const removed = [];
  const app = comparisonHarness({ async onDeleteCandidate(id) { removed.push(id); } });
  app.selectCandidate(candidate.id);
  app.field("Scale (%)").onCommit(140);
  app.render();
  app.button("Remove candidate photo").onClick();
  await Promise.resolve();
  app.render();

  assert.deepEqual(removed, [candidate.id]);
  assert.equal(app.pane().photos.candidate, undefined);
  assert.equal(app.pane().alignment.candidate.scale, 1);
  assert.equal(app.candidateOption(candidate.id), null);
  assert.equal(app.button("Save comparison").disabled, true);
});

test("refusing to remove a candidate used by a saved comparison keeps the photo", async () => {
  const error = "This image is used by a saved comparison.";
  const app = comparisonHarness({ async onDeleteCandidate() { throw new Error(error); } });
  app.selectCandidate(candidate.id);
  app.button("Remove candidate photo").onClick();
  await Promise.resolve();
  app.render();

  assert.equal(app.error(), error);
  assert.equal(app.pane().photos.candidate.id, candidate.id);
  assert.ok(app.candidateOption(candidate.id));
});

test("layer drag uses zoom-adjusted coordinates and viewport pan leaves the offset intact", () => {
  const { INITIAL_ALIGNMENT, layerOffset, viewPoint } = createLoader()("src/lib/imageAlignment.ts");
  const layer = layerOffset({ x: 0, y: 0 }, 90, -36, 300, 3);
  const alignment = { ...INITIAL_ALIGNMENT, zoom: 3, pan: { x: 0.1, y: -0.02 } };
  assert.deepEqual(layer, { x: 0.1, y: -0.04 });
  assert.deepEqual(viewPoint(layer, alignment, 300), { left: 180, top: -54 });
  assert.deepEqual(viewPoint(layer, alignment, 150), { left: 90, top: -27 });
});
