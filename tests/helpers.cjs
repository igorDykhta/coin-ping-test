const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");

// Run the actual TS sources with injected browser boundaries; no emitted files.
function createLoader(mocks = {}, globals = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(root, file);
    if (cache.has(file)) return cache.get(file).exports;
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    const module = { exports: {} };
    cache.set(file, module);
    const localRequire = (name) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (!name.startsWith(".")) return require(name);
      const base = path.resolve(path.dirname(file), name).replace(/\.js$/, "");
      const resolved = [base, `${base}.ts`, `${base}.tsx`].find((p) => fs.existsSync(p));
      return load(resolved);
    };
    new Function("require", "module", "exports", ...Object.keys(globals), code)(
      localRequire, module, module.exports, ...Object.values(globals),
    );
    return module.exports;
  }
  return load;
}

// A deterministic hook runner for lifecycle/state tests, not a DOM renderer.
function createHookRunner() {
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let effects = [];
  let renderFunction;
  let result;
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, (next) => {
        const value = typeof next === "function" ? next(slots[i].value) : next;
        if (!Object.is(value, slots[i].value)) {
          slots[i].value = value;
          dirty = true;
        }
      }];
    },
    useRef(initial) {
      const i = cursor++;
      slots[i] ??= { current: initial };
      return slots[i];
    },
    useMemo(factory, deps) {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { value: factory(), deps };
      return slots[i].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) {
        const cleanup = slots[i]?.cleanup;
        slots[i] = { deps };
        effects.push(() => { cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  return {
    react,
    render(fn = renderFunction) {
      renderFunction = fn;
      let iterations = 0;
      do {
        dirty = false;
        cursor = 0;
        effects = [];
        result = fn();
        for (const effect of effects) effect();
        if (++iterations > 25) throw new Error("Hook render loop did not settle");
      } while (dirty);
      return result;
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function createAudioHarness({ media, resume, MediaRecorder, decodeAudioData } = {}) {
  const runner = createHookRunner();
  const requests = [], streams = [], contexts = [], frames = new Map();
  let now = 10, nextFrame = 0, options = { fftSize: 8192 }, api;
  function makeStream() {
    const track = { stopped: false, onended: null, stop() { this.stopped = true; } };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    streams.push(stream);
    return stream;
  }
  class AudioContext {
    constructor() { this.state = "running"; this.sampleRate = 48000; contexts.push(this); }
    async resume() { await resume?.(); }
    async close() { this.state = "closed"; }
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createBufferSource() { return { connect() {}, start() {} }; }
    async decodeAudioData(buffer) { return decodeAudioData(buffer); }
    createAnalyser() {
      return {
        fftSize: 8192,
        connect() {},
        get frequencyBinCount() { return this.fftSize / 2; },
        getFloatFrequencyData(buffer) { buffer.fill(-40); },
      };
    }
  }
  const load = createLoader({ react: runner.react }, {
    navigator: { mediaDevices: { getUserMedia(constraints) {
      requests.push(constraints);
      return media ? media() : Promise.resolve(makeStream());
    } } },
    AudioContext,
    MediaRecorder,
    performance: { now: () => now },
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const { useAudioCapture } = load("src/hooks/useAudioCapture.ts");
  function render(next = {}) {
    options = { ...options, ...next };
    api = runner.render(() => useAudioCapture(options));
    return api;
  }
  render();
  return {
    render, makeStream, requests, streams, contexts, frames,
    get api() { return api; },
    frame(time) {
      now = time;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(time);
      return render();
    },
    unmount: runner.unmount,
  };
}

module.exports = { root, createLoader, createHookRunner, createAudioHarness, deferred };
