const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHookRunner, createLoader } = require("./helpers.cjs");

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, predicate));
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props?.children, predicate)];
}

function name(node) {
  return typeof node.type === "string" ? node.type : node.type?.name;
}

function catalogHarness(api = {}) {
  const hooks = createHookRunner();
  let active = hooks;
  const react = Object.fromEntries(Object.keys(hooks.react).map((hook) => [
    hook, (...args) => active.react[hook](...args),
  ]));
  const ui = Object.fromEntries(["Badge", "Button", "Card", "CardContent", "CardHeader", "Input", "Label"].map((type) => [type, type]));
  const load = createLoader({ react, "@sqlrooms/ui": ui }, { window: { coinCatalogApi: api } });

  function mount(component, initialProps) {
    const runner = createHookRunner();
    let props = initialProps;
    let tree;
    function render(next = {}) {
      props = { ...props, ...next };
      const previous = active;
      active = runner;
      try {
        tree = runner.render(() => component(props));
      } finally {
        active = previous;
      }
    }
    function find(type, predicate) {
      const matches = elements(tree, (node) => name(node) === type && (!predicate || predicate(node)));
      assert.ok(matches.length, `No ${type} found`);
      return matches[0];
    }
    render();
    return {
      render,
      find,
      all: (type) => elements(tree, (node) => name(node) === type),
      mountChild(type) {
        const child = find(type);
        return mount(child.type, child.props);
      },
      button(label) { return find("Button", (node) => node.props.children === label).props; },
      click(label) {
        const button = this.button(label);
        assert.ok(!button.disabled, `${label} is disabled`);
        button.onClick();
        render();
      },
      field(label) { return find("CatalogField", (node) => node.props.label === label).props; },
      fill(label, value) {
        this.field(label).onChange({ target: { value } });
        render();
      },
      select(label, value) {
        find("CatalogSelect", (node) => node.props.label === label).props.onChange(value);
        render();
      },
      submit() {
        find("form").props.onSubmit({ preventDefault() {} });
        render();
      },
      error() { return find("CatalogError").props.error; },
    };
  }

  return { load, mount };
}

const flush = () => new Promise(setImmediate);
const coin = (id, fields = {}) => ({
  id, name: `Coin ${id}`, archived: false, images: [], references: [], specifications: [], sessions: [],
  primaryObverseId: null, primaryReverseId: null, referenceCount: 0, imageCount: 0,
  sessionCount: 0, nominalWeight: null, ...fields,
});

test("catalog search and filters combine, clear, and show archived coins separately", () => {
  const h = catalogHarness();
  const selected = [];
  const { CoinCatalog } = h.load("src/components/CoinCatalog.tsx");
  const catalog = h.mount(CoinCatalog, {
    onSelect: (id) => selected.push(id),
    coins: [
      coin(1, { name: "Silver Eagle", country: "US", mint: "West Point", yearFrom: 1986, yearTo: 2021, referenceCount: 1 }),
      coin(2, { name: "Gold Eagle", country: "US", mint: "West Point", yearFrom: 2024, referenceCount: 1 }),
      coin(3, { name: "Silver Britannia", country: "UK", yearFrom: 2000 }),
      coin(4, { name: "Archived Eagle", country: "US", archived: true, yearFrom: 2000, referenceCount: 1 }),
    ],
  });
  const ids = () => catalog.all("CoinCard").map(({ props }) => props.coin.id);
  assert.deepEqual(ids(), [1, 2, 3]);
  catalog.fill("Search coins", " WEST point ");
  assert.deepEqual(ids(), [1, 2]);
  catalog.fill("Year", "2000");
  catalog.select("Available data", "sound");
  assert.deepEqual(ids(), [1]);
  catalog.find("CoinCard").props.onSelect();
  assert.deepEqual(selected, [1]);
  catalog.click("Clear filters");
  assert.deepEqual(ids(), [1, 2, 3]);
  catalog.find("input", (node) => node.props.type === "checkbox").props.onChange({ target: { checked: true } });
  catalog.render();
  assert.deepEqual(ids(), [4]);
});

test("a catalog card falls back to the remaining photo when the visible face is removed", () => {
  const h = catalogHarness();
  const { CoinCatalog } = h.load("src/components/CoinCatalog.tsx");
  const withPhotos = coin(1, { primaryObverseId: 10, primaryReverseId: 20, imageCount: 2 });
  const catalog = h.mount(CoinCatalog, { coins: [withPhotos] });
  const card = catalog.mountChild("CoinCard");
  card.click("Show reverse");
  assert.equal(card.find("CatalogPhoto").props.id, 20);
  card.render({ coin: { ...withPhotos, primaryReverseId: null, imageCount: 1 } });
  assert.equal(card.find("CatalogPhoto").props.id, 10);
  assert.deepEqual(card.all("Button"), []);
});

test("coin creation keeps invalid year ranges in the form and submits corrected values", async () => {
  const submitted = [];
  const h = catalogHarness();
  const { CoinCatalogForm } = h.load("src/components/CoinCatalogForm.tsx");
  const form = h.mount(CoinCatalogForm, { onSave: async (input) => submitted.push(input) });
  form.fill("Coin name", "  Ancient coin  ");
  form.fill("Year or start year", "-20");
  form.fill("End year (optional)", "-40");
  form.submit();
  await flush();
  form.render();
  assert.match(form.error(), /end year must be/);
  assert.deepEqual(submitted, []);
  assert.equal(form.field("Coin name").value, "  Ancient coin  ");
  form.fill("End year (optional)", "-10");
  form.submit();
  await flush();
  form.render();
  assert.equal(form.error(), null);
  assert.equal(submitted[0].name, "Ancient coin");
  assert.equal(submitted[0].yearFrom, -20);
  assert.equal(submitted[0].yearTo, -10);
});

test("changing a specification metric clears values entered in the previous unit", async () => {
  const submitted = [];
  const h = catalogHarness({ updateSpecification: async (id, input) => submitted.push({ id, input }) });
  const { CoinSpecifications } = h.load("src/components/CoinSpecifications.tsx");
  const specs = h.mount(CoinSpecifications, {
    coinId: 1, specifications: [{ id: 4, metric: "weight", nominal: 32, min: 31, max: 33 }],
    onChanged: async () => {},
  });
  specs.click("Edit");
  const form = specs.mountChild("SpecificationForm");
  form.select("Metric", "density");
  assert.deepEqual(["Nominal value", "Minimum", "Maximum"].map((label) => form.field(`${label} (g/cm³)`).value), ["", "", ""]);
  form.submit();
  await flush();
  form.render();
  assert.equal(submitted.length, 0);
  assert.match(form.error(), /nominal value or at least one range bound/);
  form.fill("Nominal value (g/cm³)", "19.3");
  form.submit();
  await flush();
  assert.equal(submitted[0].id, 4);
  assert.equal(submitted[0].input.metric, "density");
  assert.equal(submitted[0].input.nominal, 19.3);
});

test("a removed measurement range prompts for an explicit selection before saving", async () => {
  const submitted = [];
  const h = catalogHarness({ createMeasurement: async (id, input) => submitted.push({ id, input }) });
  const { CoinTestHistory } = h.load("src/components/CoinTestHistory.tsx");
  const range = { id: 3, metric: "conductivity", min: 42, max: 49 };
  const weight = { id: 4, metric: "weight", min: 31, max: 33 };
  const entry = h.mount(CoinTestHistory, {
    coin: coin(1, {
      specifications: [range, weight],
      sessions: [{ id: 10, label: "Bench test", createdAt: "2026-10-31T10:00:00Z", comparisons: [], measurements: [], soundResults: [] }],
    }),
    onChanged: async () => {},
  }).mountChild("SessionEntry");
  entry.click("Add reading");
  const form = entry.mountChild("MeasurementForm");
  form.select("Metric", "conductivity");
  assert.deepEqual(form.all("option").filter(({ props }) => props.value === 4), []);
  form.fill("Reading (MS/m)", "45");
  form.select("Reference range", "3");
  form.render({ specifications: [weight] });
  assert.equal(form.button("Save reading").disabled, true);
  assert.ok(form.all("option").some(({ props }) => props.children === "Previously selected range is unavailable"));
  form.select("Reference range", "");
  assert.equal(form.button("Save reading").disabled, false);
  form.submit();
  await flush();
  assert.deepEqual(submitted, [{
    id: 10, input: { metric: "conductivity", value: 45, specificationId: null, method: "GoldScreenSensor", notes: undefined },
  }]);
});
