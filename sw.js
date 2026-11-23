// The extension's service worker: notices a tab whose page shows a check, decides from the site's
// mode, the pause and the switches whether to answer it, holds that tab's debugger while the
// solvers (wasm/, compiled; see NOTICE) answer it, and lets go once the check is gone, no
// attempt is left, or the person stops it. Each tab's state is written to chrome.storage.session
// (`tab:<id>`) as it changes, for the popup and the toolbar icon, and read back when a new worker
// starts; every finished solve goes to the history in chrome.storage.local. The solvers' networks
// run here on onnxruntime-web, on the GPU (WebGPU) where the browser gives one. Nothing leaves the
// browser: the worker makes no network request of its own.

import * as ort from "./ort/ort.webgpu.bundle.min.mjs";
import init, * as solver from "./wasm/neuland_challenge_wasm.js";
import { HISTORY_KEPT, MODELS, PHASES, hostOf, modeOf, offKey, pausedUntil, tabKey, vendorById, vendorOfCheck } from "./ui/common.js";
import { TINTS, iconSet } from "./ui/toolbar.js";
import "./patterns.js";

// The runtime's script is in the bundle; only its WebAssembly is fetched. A path for the script as
// well would have it import() that, which a service worker may not.
ort.env.wasm.wasmPaths = { wasm: chrome.runtime.getURL("ort/ort-wasm-simd-threaded.asyncify.wasm") };
// A service worker has no SharedArrayBuffer, so ONNX Runtime's CPU fallback runs on one thread.
ort.env.wasm.numThreads = 1;

/** Whether a page's markup shows a check the solvers may know, before the debugger is taken. */
const shows = html => globalThis.NEUCAP_PATTERNS.some(p => p.frame?.test(html) || p.markup?.test(html));

const sessions = new Map(); // model name -> { session, info }
const attached = new Map(); // tab id -> [{ targetId, sessionId, url, parentFrameId }]
let ready = null;

const within = (promise, ms) =>
  Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms))]);
const pause = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- models

/** Where each network is, as the popup and options page show it: { st: "loading" | "opening" |
 * "webgpu" | "cpu" | "failed", pct, ms, fell, error }. A network not listed is not loaded; a new
 * worker starts with none. */
const modelState = {};
let modelWrite = null;
function setModel(name, patch) {
  modelState[name] = { ...(modelState[name] ?? {}), ...patch };
  // Loading writes its progress often; the storage sees it at most four times a second.
  modelWrite ??= setTimeout(() => {
    modelWrite = null;
    chrome.storage.session.set({ models: { ...modelState } }).catch(() => {});
  }, 250);
}

/** Whether WebGPU runs the networks here; false once a network failed or stalled on it. */
let gpu = true;

/** One run on zeros, as the network's inputs are shaped (an open dimension as 1). */
async function warm(session, info) {
  const feeds = {};
  session.inputNames.forEach((name, i) => {
    const dims = info.inputDims[i].map(d => (d < 0 ? 1 : d));
    const type = (session.inputMetadata?.[i]?.type) ?? "float32";
    const size = dims.reduce((a, b) => a * b, 1);
    feeds[name] = new ort.Tensor(type, type === "int64" ? new BigInt64Array(size) : new Float32Array(size), dims);
  });
  await session.run(feeds);
}

/** A session for one network: on the GPU where a first run there answers in time, else on the CPU,
 * as the person's choice in the options page allows ("auto", "gpu" or "cpu"). */
async function open(name, bytes) {
  const { compute = "auto" } = await chrome.storage.local.get("compute");
  if (compute !== "cpu" && (gpu || compute === "gpu")) {
    try {
      const started = Date.now();
      const session = await within(ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"] }), 60_000);
      const info = describe(session, "webgpu");
      try {
        await within(warm(session, info), 30_000);
      } catch (e) {
        // The GPU memory of a session that did not answer is given back.
        await within(Promise.resolve(session.release?.()), 5_000).catch(() => {});
        throw e;
      }
      console.log(`${name} runs on WebGPU, ready in ${Date.now() - started} ms`);
      return { session, info };
    } catch (e) {
      // Some GPUs (software ones above all) never answer a run; every later network goes to the CPU.
      console.warn(`${name} does not run on WebGPU here: ${e}`);
      if (compute === "gpu") throw new Error(`${name} does not run on WebGPU here: ${e}`);
      gpu = false;
      setModel(name, { fell: true });
    }
  }
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  return { session, info: describe(session, "wasm") };
}

function describe(session, provider) {
  const meta = session.inputMetadata ?? [];
  return {
    provider,
    inputNames: session.inputNames,
    inputDims: meta.map(m => (m.shape ?? []).map(d => (typeof d === "number" ? d : -1))),
  };
}

/** What each network takes ({inputNames, inputDims}), read from the models at build time
 * (model-info.mjs): the readers are made from it, and a network is loaded only once a check runs it. */
const infos = new Map();

/** The model's bytes as the extension carries them, read with progress; none where it does not. */
async function bytesOf(name) {
  const answer = await fetch(chrome.runtime.getURL(`models/${name}.onnx`)).catch(() => null);
  if (!answer?.ok) return null;
  const total = Number(answer.headers.get("content-length")) || 0;
  if (!total || !answer.body) return new Uint8Array(await answer.arrayBuffer());
  const bytes = new Uint8Array(total);
  const reader = answer.body.getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.set(value, at);
    at += value.length;
    setModel(name, { st: "loading", pct: Math.round(at / total * 100) });
  }
  return bytes;
}

/** The session of network `name`, loaded on its first run and kept while the worker lives; runs
 * asking for it at once wait for the one load. */
const loading = new Map(); // model name -> promise of { session, info }
function loaded(name) {
  const held = sessions.get(name);
  if (held) return Promise.resolve(held);
  if (!loading.has(name)) {
    loading.set(name, (async () => {
      const started = Date.now();
      try {
        setModel(name, { st: "loading", pct: 0, error: null });
        const bytes = await bytesOf(name);
        if (!bytes) throw new Error(`no model ${name}`);
        setModel(name, { st: "opening", pct: 100 });
        const opened = await open(name, bytes);
        sessions.set(name, opened);
        setModel(name, { st: opened.info.provider === "webgpu" ? "webgpu" : "cpu", ms: Date.now() - started });
        return opened;
      } catch (e) {
        setModel(name, { st: "failed", error: String(e).slice(0, 200) });
        throw e;
      } finally {
        loading.delete(name);
      }
    })());
  }
  return loading.get(name);
}

/** Lets network `name` go, once a load of it under way has ended; the next run loads it again. */
async function release(name) {
  await loading.get(name)?.catch(() => {});
  const held = sessions.get(name);
  sessions.delete(name);
  delete modelState[name];
  chrome.storage.session.set({ models: { ...modelState } }).catch(() => {});
  if (held) await within(Promise.resolve(held.session.release?.()), 5_000).catch(() => {});
}

/** Loads the wasm and what every network takes; no network itself. A load that failed is tried
 * again on the next call. */
function prepare() {
  ready ??= (async () => {
    await init({ module_or_path: chrome.runtime.getURL("wasm/neuland_challenge_wasm_bg.wasm") });
    const answer = await fetch(chrome.runtime.getURL("models/info.json")).catch(() => null);
    const known = answer && answer.ok ? await answer.json().catch(() => null) : null;
    if (!known) console.error("models/info.json does not read: no reader that needs a network can run");
    for (const name of MODELS) if (known?.[name]) infos.set(name, known[name]);
    solver.reset();
  })().catch(e => {
    ready = null;
    throw e;
  });
  return ready;
}

// ---------------------------------------------------------------- the solvers' bridge

/** The last commands the solvers sent, with how they ended, for looking into a solve that stalls. */
const trace = [];
// Enough for a solve and the minute and a half of watching after it.
const TRACE_KEPT = 3000;
globalThis.neulandTrace = trace;
const traced = entry => {
  trace.push(entry);
  if (trace.length > TRACE_KEPT) trace.shift();
  return entry;
};

/** How long one command to the tab, one look at its markup, one attempt and one look at whether
 * the check stands may take before the solve gives up on the tab: a dialog the page opened
 * (alert, beforeunload) or a renderer that hangs answers nothing at all. */
const COMMAND_MS = 15_000;
const ATTEMPT_MS = 180_000;

/** Tabs whose debugger this worker holds, and how often it took each tab's (read by the tests). */
const holding = new Set();
const takes = {};
const born = Date.now();
globalThis.neucapHolding = () => ({ holding: [...holding], takes: { ...takes }, born });
async function attachTo(tab) {
  await releasing.get(tab);
  const attach = chrome.debugger.attach({ tabId: tab }, "1.3");
  try {
    await within(attach, COMMAND_MS);
  } catch (e) {
    // An attach that answers after its time is let go as soon as it does.
    attach.then(() => chrome.debugger.detach({ tabId: tab })).catch(() => {});
    throw e;
  }
  holding.add(tab);
  takes[tab] = (takes[tab] ?? 0) + 1;
}
async function detachFrom(tab) {
  holding.delete(tab);
  await chrome.debugger.detach({ tabId: tab }).catch(() => {});
}

/** Each solve running, by tab: { tab, handle, halted, why, attached, forced, models, ended }. */
const runs = new Map();
/** The solvers know a solve by a handle of its own instead of the tab's id, so whatever a halted
 * solve still has in hand reaches nothing, even once a new solve runs on the same tab. */
const handles = new Map(); // handle -> run
let nextHandle = 1;

globalThis.neulandBridge = {
  cdp: async (handle, session, method, params) => {
    const run = handles.get(handle);
    const entry = traced({ at: Date.now(), tab: run?.tab, method, session: session ? session.slice(0, 8) : null, params: JSON.stringify(params ?? {}).slice(0, 160) });
    if (!run || run.halted) {
      entry.error = "halted";
      throw new Error("the solve was halted");
    }
    try {
      const answer = await within(chrome.debugger.sendCommand(session ? { tabId: run.tab, sessionId: session } : { tabId: run.tab }, method, params ?? {}), COMMAND_MS);
      entry.ms = Date.now() - entry.at;
      entry.answer = JSON.stringify(answer ?? null).slice(0, 160);
      return answer;
    } catch (e) {
      entry.ms = Date.now() - entry.at;
      entry.error = String(e).slice(0, 200);
      throw e;
    }
  },
  targets: handle => {
    const run = handles.get(handle);
    const list = run ? attached.get(run.tab) ?? [] : [];
    const shown = JSON.stringify(list.map(t => [t.sessionId.slice(0, 4), t.targetId.slice(0, 6), t.url.slice(-45), t.parentFrameId?.slice(0, 6)]));
    if (trace.at(-1)?.answer !== shown) traced({ at: Date.now(), tab: run?.tab, method: "targets", session: null, params: "", ms: 0, answer: shown });
    return list;
  },
  model_info: name => infos.get(name) ?? null,
  run_model: async (name, inputs) => {
    const entry = traced({ at: Date.now(), method: `model ${name}`, session: null, params: JSON.stringify(inputs.map(i => [i.name, i.type, i.dims])) });
    // A network is put to the solve running when only one runs; with several it is not told apart.
    const only = runs.size === 1 ? [...runs.values()][0] : null;
    // With several solves running, none of them can tell whose run this was.
    if (runs.size > 1) for (const r of runs.values()) r.unattributed = true;
    if (only && !only.models.has(name)) {
      only.models.add(name);
      setTab(only.tab, {}).catch(() => {});
    }
    const run = async session => {
      const feeds = {};
      for (const input of inputs) feeds[input.name] = new ort.Tensor(input.type, input.data, input.dims);
      const out = (await session.run(feeds))[session.outputNames[0]];
      return { dims: out.dims, data: out.location === "cpu" ? out.data : await out.getData() };
    };
    try {
      let answer;
      const { session, info } = await loaded(name);
      try {
        answer = info.provider === "webgpu" ? await within(run(session), 30_000) : await run(session);
      } catch (e) {
        // Only a run the GPU did not answer in time sends the networks to the CPU; any other
        // failure (a session let go from the options page) is the run's own.
        if (info.provider !== "webgpu" || !/^Error: no answer in/.test(String(e))) throw e;
        // Only the session this run stalled on is let go: another run may have replaced it already.
        console.warn(`${name} stopped answering on WebGPU: ${e}`);
        gpu = false;
        if (sessions.get(name)?.session === session) {
          sessions.delete(name);
          setModel(name, { fell: true });
          // Releasing may wait behind the stalled run itself.
          await within(Promise.resolve(session.release?.()), 5_000).catch(() => {});
        }
        answer = await run((await loaded(name)).session);
      }
      entry.ms = Date.now() - entry.at;
      entry.answer = JSON.stringify(answer.dims);
      return answer;
    } catch (e) {
      entry.ms = Date.now() - entry.at;
      entry.error = String(e).slice(0, 200);
      throw e;
    }
  },
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Target.attachedToTarget" && params.targetInfo.type === "iframe") {
    const list = attached.get(source.tabId) ?? [];
    list.push({ targetId: params.targetInfo.targetId, sessionId: params.sessionId, url: params.targetInfo.url, parentFrameId: params.targetInfo.parentFrameId });
    attached.set(source.tabId, list);
    // A frame inside this one, in a process of its own, is attached to as well.
    chrome.debugger.sendCommand({ tabId: source.tabId, sessionId: params.sessionId }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  } else if (method === "Target.detachedFromTarget") {
    attached.set(source.tabId, (attached.get(source.tabId) ?? []).filter(t => t.sessionId !== params.sessionId));
  } else if (method === "Target.targetInfoChanged") {
    for (const t of attached.get(source.tabId) ?? []) if (t.targetId === params.targetInfo.targetId) t.url = params.targetInfo.url;
  }
});

// The debugger let go from outside: the person pressed Cancel on the browser's bar, the tab closed
// or its renderer went away, or DevTools took over. The solve halts where it is; whether the tab
// still exists tells a closed tab from the rest.
chrome.debugger.onDetach.addListener((source, reason) => {
  attached.delete(source.tabId);
  holding.delete(source.tabId);
  const run = runs.get(source.tabId);
  if (!run || run.halted) return;
  run.attached = false;
  // Halted at once, so the solver's next command fails as halted instead of as an error; whether
  // the tab still exists decides how the solve is kept.
  stopRun(run, "detached");
  chrome.tabs.get(source.tabId).then(
    () => halt(run, reason === "canceled_by_user" ? "cancelled" : "detached", reason === "canceled_by_user" ? null : `the debugger was let go: ${reason}`),
    () => halt(run, "closed"),
  );
});

// ---------------------------------------------------------------- tab state

/** Each tab's state, as written to chrome.storage.session; restored when a worker starts. */
const tabs = new Map();
/** Tabs closed while this worker runs: nothing is written for them any more. */
const closed = new Set();

/** Writes tab `tab`'s state merged with `patch` (null forgets it) and redraws its icon. */
async function setTab(tab, patch) {
  if (patch === null) {
    tabs.delete(tab);
    await chrome.storage.session.remove(tabKey(tab));
  } else {
    if (closed.has(tab)) return;
    const run = runs.get(tab);
    const next = { ...(tabs.get(tab) ?? {}), ...patch };
    if (run) next.models = [...run.models];
    tabs.set(tab, next);
    await chrome.storage.session.set({ [tabKey(tab)]: next });
  }
  if (!closed.has(tab)) await drawTab(tab).catch(() => {});
}

const looks = new Map();
const look = (state, progress) => {
  const key = `${state}:${progress ?? ""}`;
  if (!looks.has(key)) looks.set(key, iconSet(state, progress));
  return looks.get(key);
};

/** The toolbar icon, badge and title of tab `tab` from its state; a phase this worker does not
 * know draws as unknown. */
async function drawTab(tab) {
  const s = tabs.get(tab);
  const paused = await pausedUntil();
  let state = s?.phase ?? (paused ? "paused" : "idle");
  if (state !== "idle" && !PHASES.includes(state)) state = "unknown";
  const progress = state === "solving" && s.of ? (s.attempt - 0.5) / s.of : undefined;
  await chrome.action.setIcon({ tabId: tab, imageData: look(state, progress === undefined ? undefined : Math.round(progress * 12) / 12) });
  await chrome.action.setBadgeText({ tabId: tab, text: state === "solving" && s.of ? `${s.attempt}/${s.of}` : "" });
  if (state === "solving") await chrome.action.setBadgeBackgroundColor({ tabId: tab, color: TINTS.acc });
  const vendor = s?.vendor ? vendorById(s.vendor)?.name ?? s.vendor : "";
  await chrome.action.setTitle({ tabId: tab, title: `Opens NeuCap${state === "idle" ? "" : `: ${state}${vendor ? `, ${vendor}` : ""}`}` });
}

/** The icon of tabs NeuCap has nothing on, which shows the pause. */
async function drawDefault() {
  const paused = await pausedUntil();
  await chrome.action.setIcon({ imageData: look(paused ? "paused" : "idle") });
}

// ---------------------------------------------------------------- history

let historyChain = Promise.resolve();
/** Runs `write` after every history write before it, so two tabs ending at once keep both; one
 * that fails leaves the next ones running. */
function historyWrite(write) {
  const next = historyChain.then(write);
  historyChain = next.catch(e => console.error("history not written", e));
  return next;
}
const remember = entry => historyWrite(async () => {
  const { history = [] } = await chrome.storage.local.get("history");
  history.unshift(entry);
  if (history.length > HISTORY_KEPT) history.length = HISTORY_KEPT;
  await chrome.storage.local.set({ history });
}).catch(() => {});

/** A solve's history entry from its tab state: host, vendor, check, outcome, timings, error and
 * where its networks ran; nothing of the page beyond its host. */
/** An error as kept: every address in it cut to its host, as the history keeps no more of a page. */
const clean = e => (e == null ? null : String(e).replace(/\bhttps?:\/\/([^\/\s"')]+)[^\s"')]*/g, "$1").slice(0, 300));

/** Where the networks of the solve in `s` ran: GPU, CPU, none, or unknown. */
function ranOn(s) {
  if (s.unattributed) return "unknown";
  const names = s.models ?? [];
  if (!names.length) return "none";
  const providers = names.map(n => sessions.get(n)?.info.provider ?? modelState[n]?.st);
  if (providers.includes("webgpu")) return "GPU";
  if (providers.some(p => p === "wasm" || p === "cpu")) return "CPU";
  return "unknown";
}

function entryOf(s, outcome) {
  const ran = ranOn(s);
  return {
    id: s.entryId ?? crypto.randomUUID(),
    at: s.startedAt ?? Date.now(), host: s.host, vendor: s.vendor ?? null, check: s.check ?? null, outcome,
    attempts: s.attempts ?? [], ms: s.startedAt ? Date.now() - s.startedAt : 0, error: clean(s.error), ran,
  };
}

// ---------------------------------------------------------------- deciding and solving

async function html(tab) {
  const [shown] = await within(chrome.scripting.executeScript({ target: { tabId: tab }, func: () => document.documentElement.outerHTML }), COMMAND_MS);
  return shown?.result ?? "";
}

/** The checks of vendor `id` the solvers carry, once they are loaded; the vendor's whole list before. */
const carried = id => {
  const checks = vendorById(id)?.checks ?? [];
  if (!ready) return checks;
  try {
    const names = new Set(solver.names());
    return checks.filter(c => names.has(c));
  } catch {
    return checks;
  }
};

/** Whether every check of vendor `id` the solvers carry is turned off. */
async function vendorOff(id) {
  const checks = carried(id);
  if (!checks.length) return false;
  const got = await chrome.storage.local.get(checks.map(offKey));
  return checks.every(c => got[offKey(c)]);
}

/** Phases a page keeps until it changes address: the check is not tried again by itself. */
const SETTLED = ["solved", "failed", "stopped", "unsupported", "interrupted"];

/** Solves started by themselves on each tab lately: past four in two minutes the tab waits for the
 * person, whatever the pages it goes through say. */
const lately = new Map();
const REPEAT_WINDOW = 120_000, REPEAT_MAX = 4;
function tooOften(tab) {
  const recent = (lately.get(tab) ?? []).filter(t => Date.now() - t < REPEAT_WINDOW);
  lately.set(tab, recent);
  return recent.length >= REPEAT_MAX;
}

/** A check the page on tab `tab` (at `url`) shows, by `vendor` as detect.js tells it: answered now,
 * waited on (Ask), or only recorded (site off, NeuCap paused, vendor off). `force` is the person's
 * own Solve now, Solve once or Try again; `again` the one retry of a solve a stopped worker left. */
async function consider(tab, url, vendor, force = false, again = false) {
  if (!again) await restored;
  const host = hostOf(url);
  if (!host || runs.has(tab) || closed.has(tab)) return;
  if (!(await chrome.tabs.get(tab).catch(() => null))) return;
  const was = tabs.get(tab);
  const same = was && was.url === url;
  const base = { host, url, vendor: vendor ?? (same ? was.vendor : null) ?? null, seenAt: same && was.seenAt ? was.seenAt : Date.now(), resumed: again };
  if (!force) {
    // A page the check sent the tab to after passing (`left`) is a page of its own.
    if (!again && same && !was.left && (SETTLED.includes(was.phase) || (was.phase === "off" && was.reason === "check"))) return;
    let wait = null;
    if (await pausedUntil()) wait = { phase: "paused" };
    else {
      const mode = await modeOf(host);
      if (mode === "off") wait = { phase: "off", reason: "site" };
      else if (base.vendor && await vendorOff(base.vendor)) wait = { phase: "off", reason: "vendor" };
      else if (mode === "ask") wait = { phase: "found" };
      else if (tooOften(tab)) wait = { phase: "found", reason: "repeat" };
    }
    if (wait) {
      // The page tells the same every few seconds; only a change is written.
      if (same && was.phase === wait.phase && was.reason === (wait.reason ?? was.reason)) return;
      return setTab(tab, { ...base, reason: null, ...wait });
    }
  }
  if (!force) lately.get(tab)?.push(Date.now()) ?? lately.set(tab, [Date.now()]);
  return solve(tab, base, force);
}
const considered = (...args) => consider(...args).catch(e => console.error("consider", e));

/** Marks `run` halted: from here no command of its solvers goes out, and the tab is free for a new
 * solve. */
function stopRun(run, why) {
  if (run.halted) return false;
  run.halted = true;
  run.why = why;
  if (runs.get(run.tab) === run) runs.delete(run.tab);
  return true;
}

/** Each tab's debugger being let go by a halted solve; the next attach to the tab waits for it. */
const releasing = new Map();

/** Halts `run`: no command of its solvers goes out after this, its debugger is let go now (or as
 * soon as an attach under way lands), and how it ended (`why`: stop, cancelled, site, ask,
 * paused, vendor, left, timeout, detached, closed) is written at once, so the person may try
 * again right away. */
async function halt(run, why, error = null) {
  if (run.ended) return;
  stopRun(run, why);
  run.why = why;
  const tab = run.tab;
  const letGo = (async () => {
    await run.attaching?.catch(() => {});
    if (run.attached || run.attaching) {
      run.attached = false;
      await detachFrom(tab);
    }
  })();
  releasing.set(tab, letGo);
  letGo.finally(() => { if (releasing.get(tab) === letGo) releasing.delete(tab); });
  await letGo;
  attached.delete(tab);
  if (error) run.error = error;
  // A page left before the solver acted holds nothing of this solve: the new page starts afresh.
  const halted = why === "left" ? "gone" : why === "timeout" || why === "detached" ? "error" : why === "closed" ? "closed" : "stopped";
  await end(run, run.finishing && halted !== "closed" ? run.finishing : halted);
  if (reloadWanted) checkUpdate().catch(() => {});
}

/** Answers the check tab `tab` shows, if it shows one the solvers know. */
async function solve(tab, base, force) {
  if (runs.has(tab)) return;
  const run = { tab, handle: nextHandle++, halted: false, why: null, attached: false, forced: force, models: new Set(), ended: false, base, entryId: crypto.randomUUID() };
  // What the solvers keep is not told apart between solves that run at once.
  for (const other of runs.values()) other.shared = true;
  run.shared = runs.size > 0;
  runs.set(tab, run);
  handles.set(run.handle, run);
  let outcome = null;
  try {
    // A page that cannot be read (scripts not allowed there, a dialog open) is left as not seen.
    let page = await html(tab).catch(() => "");
    if (run.halted) return;
    if (!shows(page)) {
      outcome = "gone";
      return;
    }
    await setTab(tab, { ...base, phase: "solving", step: "debugger", reason: null, check: null, attempt: 0, of: null, attempts: [], startedAt: Date.now(), endedAt: null, attachedAt: null, error: null, outcome: null, left: null });
    await prepare();
    if (run.halted) return;
    // A vendor whose every check the solvers carry is off is not attached to at all.
    if (!force && base.vendor && await vendorOff(base.vendor)) {
      outcome = "off";
      run.reason = "vendor";
      return;
    }
    if (run.halted) return;
    run.attaching = attachTo(tab);
    await run.attaching;
    run.attaching = null;
    run.attached = true;
    if (run.halted) return;
    attached.set(tab, []);
    await within(chrome.debugger.sendCommand({ tabId: tab }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }), COMMAND_MS);
    await pause(500);
    if (run.halted) return;
    await setTab(tab, { step: "naming", attachedAt: Date.now() });
    const name = await within(solver.asking(run.handle, page), COMMAND_MS * 2);
    if (run.halted) return;
    if (!name) {
      outcome = "unsupported";
      return;
    }
    run.check = name;
    const vendor = vendorOfCheck(name)?.id ?? base.vendor;
    if (!force && (await chrome.storage.local.get(offKey(name)))[offKey(name)]) {
      outcome = "off";
      run.reason = "check";
      await setTab(tab, { vendor, check: name });
      return;
    }
    const of = solver.attempts(name);
    await setTab(tab, { vendor, check: name, of });
    for (let attempt = 0; attempt < of && !run.halted; attempt++) {
      await setTab(tab, { step: "attempt", attempt: attempt + 1 });
      const started = Date.now();
      const seconds = () => Math.round((Date.now() - started) / 100) / 10;
      let failed = null;
      const acted = await within(solver.attempt(run.handle, name, page), ATTEMPT_MS).catch(e => {
        failed = String(e);
        // An attempt past its time may still be running: nothing it sends from now reaches the tab.
        if (/no answer in/.test(failed)) {
          handles.delete(run.handle);
        }
        return false;
      });
      if (run.halted) break;
      if (failed) {
        await setTab(tab, { attempts: [...tabs.get(tab).attempts, { s: seconds(), r: "error" }], error: clean(failed) });
        outcome = "error";
        break;
      }
      console.log("attempt", JSON.stringify({ name, attempt, acted, seconds: seconds() }));
      // The page is given the check's time to let it go, looked at each second.
      await setTab(tab, { step: "watching" });
      const until = Date.now() + solver.settle(name);
      let standing = true;
      while (Date.now() < until && standing && !run.halted) {
        await pause(1000);
        page = await html(tab).catch(() => "");
        // Only this check counts here: another one the page shows after it gets a solve of its own.
        // Its live state decides, since its box stays in the markup once answered.
        standing = await within(solver.standing(run.handle, name, page), COMMAND_MS).catch(() => true);
      }
      if (run.halted) break;
      await setTab(tab, { attempts: [...tabs.get(tab).attempts, { s: seconds(), r: standing ? "standing" : "passed" }] });
      if (!standing) { outcome = "passed"; break; }
      if (!acted) { outcome = "nothing"; break; }
      if (attempt === of - 1) outcome = "standing";
    }
  } catch (e) {
    if (!run.halted) {
      outcome = "error";
      run.error = clean(e);
    }
  } finally {
    handles.delete(run.handle);
    run.finishing = outcome;
    // The solvers keep the pictures they read in memory until asked for them; nothing here uses them.
    try { if (ready) solver.kept(); } catch {}
    if (run.attached) {
      run.attached = false;
      await detachFrom(tab);
    }
    if (runs.get(tab) === run) runs.delete(tab);
    if (!run.halted) {
      attached.delete(tab);
      await end(run, outcome).catch(e => console.error("solve end not written", e));
    }
    // A newer build waiting for this solve loads now, if no other solve runs.
    if (reloadWanted) checkUpdate().catch(() => {});
  }
}

/** Writes how `run` ended, once: the tab's state, the history and a notice of a failure. */
async function end(run, outcome) {
  if (run.ended) return;
  run.ended = true;
  const tab = run.tab;
  const s = { ...run.base, ...(tabs.get(tab) ?? {}), models: [...run.models], unattributed: !!run.unattributed, entryId: run.entryId };
  if (run.error) s.error = clean(run.error);
  if (run.left) s.url = run.left;
  if (outcome === "closed") {
    if (s.startedAt) await remember(entryOf({ ...s, error: "tab closed" }, "closed"));
    await setTab(tab, null).catch(() => {});
    return;
  }
  if (outcome === "gone" || outcome === null) {
    // The check or the page left before the solver acted: nothing was done, nothing is kept.
    if (tabs.get(tab)?.phase === "solving") await setTab(tab, null);
    return;
  }
  if (outcome === "off") {
    await setTab(tab, { ...s, phase: "off", reason: run.reason, step: null });
    return;
  }
  const phase = { passed: "solved", standing: "failed", nothing: "failed", error: "failed", stopped: "stopped", unsupported: "unsupported" }[outcome];
  await setTab(tab, { ...s, phase, step: null, endedAt: Date.now(), outcome, reason: outcome === "stopped" ? run.why : null, left: run.left ?? null });
  await remember(entryOf(s, outcome));
  if (phase === "failed" && !closed.has(tab) && (await chrome.storage.local.get("notify")).notify !== false) notify(tab, s).catch(() => {});
}

async function notify(tab, s) {
  const vendor = vendorById(s.vendor)?.name ?? "A check";
  const canvas = new OffscreenCanvas(48, 48);
  canvas.getContext("2d").putImageData(look("failed")[48], 0, 0);
  const blob = await canvas.convertToBlob();
  const iconUrl = `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())))}`;
  await chrome.notifications.create(`fail:${tab}:${Date.now()}`, { type: "basic", iconUrl, title: `${vendor} still stands`, message: s.host ?? "", silent: true });
}

/** Tabs whose state waits on a setting (Ask, off, paused) are looked at again once it changes;
 * each answer runs by itself. */
async function reconsider(filter) {
  await restored;
  for (const [tab, s] of [...tabs]) {
    if (!["found", "off", "paused"].includes(s.phase) || !filter(s)) continue;
    const vendor = await seenOn(tab);
    if (vendor === undefined) continue;
    if (vendor === null) { await setTab(tab, null); continue; }
    const t = await chrome.tabs.get(tab).catch(() => null);
    if (t?.url) {
      // A tab off for its check alone was settled by consider(); it is asked again here.
      if (s.phase === "off" && s.reason === "check") tabs.set(tab, { ...s, phase: "found" });
      considered(tab, t.url, vendor);
    }
  }
}

/** Solves running that a setting now turns away are halted, unless the person forced them. */
async function haltTurnedAway() {
  const paused = await pausedUntil();
  for (const run of [...runs.values()]) {
    if (run.forced || run.halted) continue;
    const s = tabs.get(run.tab) ?? run.base;
    if (paused) { halt(run, "paused"); continue; }
    const mode = await modeOf(s.host);
    if (mode === "off") { halt(run, "site"); continue; }
    if (mode === "ask") { halt(run, "ask"); continue; }
    const checks = s.check ? [s.check] : carried(s.vendor);
    const got = checks.length ? await chrome.storage.local.get(checks.map(offKey)) : {};
    if (checks.length && checks.every(c => got[offKey(c)])) halt(run, "vendor");
  }
}

/** The vendor whose check tab `tab` shows now, as detect.js reads it; undefined where it cannot be
 * asked (no content script there, or a page that does not answer). */
async function seenOn(tab) {
  // A script's undefined comes back as null, so the page's own answer is told apart by name.
  const [r] = await within(chrome.scripting.executeScript({ target: { tabId: tab }, func: () => (typeof globalThis.neucapShown === "function" ? globalThis.neucapShown() ?? "none" : "absent") }), 5_000).catch(() => [undefined]);
  const v = r?.result;
  return v === "none" ? null : v === "absent" || v == null ? undefined : v;
}

// ---------------------------------------------------------------- a new worker

/** A worker that starts finds the tabs' states its predecessor wrote: a solve that was running is
 * over (its debugger is let go, it is kept as interrupted) and is tried once more where the check
 * still stands and the settings allow it. */
const restored = (async () => {
  await chrome.storage.session.set({ models: {} });
  const all = await chrome.storage.session.get(null);
  const resume = [];
  for (const [key, s] of Object.entries(all)) {
    if (!key.startsWith("tab:")) continue;
    const tab = Number(key.slice(4));
    const alive = await chrome.tabs.get(tab).catch(() => null);
    if (!alive) { await chrome.storage.session.remove(key); continue; }
    tabs.set(tab, s);
    if (s.phase === "solving") {
      await chrome.debugger.detach({ tabId: tab }).catch(() => {});
      // What this solve ran died with the worker that ran it.
      const next = { ...s, phase: "interrupted", step: null, error: "the worker stopped during the solve", endedAt: Date.now(), unattributed: !!s.models?.length };
      tabs.set(tab, next);
      await chrome.storage.session.set({ [key]: next });
      await remember(entryOf(next, "interrupted"));
      if (!s.resumed) resume.push([tab, alive.url, s.vendor]);
    }
    await drawTab(tab).catch(() => {});
  }
  await drawDefault().catch(() => {});
  return resume;
})().catch(e => {
  console.error("restore", e);
  return [];
});
restored.then(async resume => {
  for (const [tab, url, vendor] of resume) {
    if ((await seenOn(tab)) == null) continue;
    // Not forced: a site turned off or a pause since then still holds.
    considered(tab, url, vendor, false, true);
  }
});

// ---------------------------------------------------------------- events

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // A page that is off or paused as it reads the settings says seen; consider() reads them again
  // and records it without a solve either way.
  if ((message?.captcha || message?.seen) && sender.tab?.id !== undefined) {
    considered(sender.tab.id, sender.tab.url, message.vendor);
    return false;
  }
  const answer = handle(message);
  if (!answer) return false;
  answer.then(reply, e => reply({ error: String(e) }));
  return true;
});

/** What the popup and the options page ask. */
function handle(m) {
  switch (m?.ask) {
    case "hello":
      // The popup's first word: a worker that was stopped starts and restores the tabs' states,
      // and the files on disk are looked at for a newer build.
      checkUpdate().catch(() => {});
      return restored.then(() => ({ ok: true }));
    case "solve":
      return (async () => {
        const t = await chrome.tabs.get(m.tab);
        const vendor = (await seenOn(m.tab)) ?? tabs.get(m.tab)?.vendor ?? null;
        considered(m.tab, t.url, vendor, true);
        return { ok: true };
      })();
    case "stop":
      return (async () => {
        const run = runs.get(m.tab);
        if (run) await halt(run, "stop");
        return { ok: !!run };
      })();
    case "resume":
      return (async () => {
        await chrome.storage.local.remove("pause");
        await chrome.storage.session.remove("pauseSession");
        return { ok: true };
      })();
    case "pause":
      return (async () => {
        if (m.for === "restart") await chrome.storage.session.set({ pauseSession: true });
        else await chrome.storage.local.set({ pause: { until: m.for === "resumed" ? null : Date.now() + m.for } });
        return { ok: true };
      })();
    case "holding":
      // For the end-to-end tests: the debugger this worker holds, and the commands it sent.
      return Promise.resolve({ ...globalThis.neucapHolding(), trace: m.trace ? trace.filter(e => e.tab === m.trace) : undefined });
    case "names":
      return prepare().then(() => ({ names: solver.names(), models: [...infos.keys()], sizes: Object.fromEntries([...infos].map(([n, i]) => [n, i.bytes ?? null])) }));
    case "load":
      return loaded(m.model).then(() => ({ ok: true }));
    case "release":
      return release(m.model).then(() => ({ ok: true }));
    case "clear":
      return historyWrite(() => chrome.storage.local.set({ history: [] })).then(() => ({ ok: true }));
    case "export":
      return (async () => {
        const local = await chrome.storage.local.get(null);
        const { history = [], ...settings } = local;
        return { version: chrome.runtime.getManifest().version, at: Date.now(), settings, history, trace, models: modelState };
      })();
    default:
      return null;
  }
}

// Settings the page or options change take effect on the tabs waiting on them and on the solves
// running.
chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  if ((area === "local" && keys.includes("pause")) || (area === "session" && keys.includes("pauseSession"))) {
    drawDefault().catch(() => {});
    pausedUntil().then(async p => {
      if (p) {
        if (typeof p === "number") chrome.alarms.create("pause-end", { when: p });
        await haltTurnedAway();
        for (const tab of tabs.keys()) await drawTab(tab).catch(() => {});
      } else await reconsider(s => s.phase === "paused");
    }).catch(e => console.error("pause change", e));
  }
  if (area !== "local") return;
  const hosts = keys.filter(k => k.startsWith("mode:")).map(k => k.slice(5));
  const offs = keys.some(k => k.startsWith("off:"));
  if (hosts.length || keys.includes("defaultMode") || offs) haltTurnedAway().catch(e => console.error("halt", e));
  if (hosts.length || keys.includes("defaultMode")) reconsider(s => keys.includes("defaultMode") || hosts.includes(s.host)).catch(e => console.error("reconsider", e));
  // Tabs off for a vendor or a check are looked at again only when one of their own checks is
  // turned back on.
  const on = keys.filter(k => k.startsWith("off:") && !changes[k].newValue).map(k => k.slice(4));
  if (on.length) reconsider(s => s.phase === "off" && ((s.reason === "vendor" && carried(s.vendor).some(c => on.includes(c))) || (s.reason === "check" && on.includes(s.check)))).catch(e => console.error("reconsider", e));
});

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === "update-check") return checkUpdate().catch(e => console.error("update check", e));
  if (a.name !== "pause-end") return;
  drawDefault().catch(() => {});
  reconsider(s => s.phase === "paused").catch(e => console.error("reconsider", e));
});

chrome.tabs.onRemoved.addListener(async tab => {
  closed.add(tab);
  const run = runs.get(tab);
  if (run) return halt(run, "closed");
  await restored;
  if (tabs.has(tab)) await setTab(tab, null).catch(() => {});
});

// A page of another address forgets what the tab showed. During a solve, a page left before the
// debugger was taken halts it; after that the solve goes on, and whether the check still stands on
// the new page decides how it ends, the state taking the new address.
chrome.tabs.onUpdated.addListener(async (tab, change) => {
  if (!change.url) return;
  const run = runs.get(tab);
  if (run) {
    if ((tabs.get(tab)?.url ?? run.base.url) === change.url) return;
    if (run.attached) run.left = change.url;
    else halt(run, "left");
    return;
  }
  await restored;
  if (tabs.has(tab) && tabs.get(tab).url !== change.url) setTab(tab, null).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command, t) => {
  const tab = t ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id) return;
  if (command === "solve-tab") {
    const vendor = (await seenOn(tab.id)) ?? null;
    considered(tab.id, tab.url, vendor, true);
  } else if (command === "cycle-mode") {
    const host = hostOf(tab.url);
    if (!host) return;
    const next = { auto: "ask", ask: "off", off: "auto" }[await modeOf(host)];
    await chrome.storage.local.set({ [`mode:${host}`]: next });
  }
});

// ---------------------------------------------------------------- updates

/** The extension is loaded unpacked from a folder a new build is written into (on pc0 by the
 * system's activation), and Chromium only reads a new build when the extension reloads. The
 * worker reads the version of the files on disk when it starts, every minute, when the popup
 * opens and after each solve, and reloads itself into a newer one once no solve runs: never
 * during a solve. A version that differs from the last one this worker family ran is kept as
 * `updated` for the popup to show. */
const VERSION = chrome.runtime.getManifest().version;
let reloadWanted = null;

async function checkUpdate() {
  const answer = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
  const onDisk = (await answer.json()).version;
  if (!onDisk || onDisk === VERSION) { reloadWanted = null; return; }
  reloadWanted = onDisk;
  if (runs.size || releasing.size) return;
  // What the last solve wrote is kept before the worker goes.
  await historyChain;
  if (runs.size || releasing.size) return;
  console.log(`reloading into ${onDisk} from ${VERSION}`);
  chrome.runtime.reload();
}

(async () => {
  const { version: last } = await chrome.storage.local.get("version");
  if (last && last !== VERSION) await chrome.storage.local.set({ updated: { from: last, to: VERSION, at: Date.now() } });
  if (last !== VERSION) await chrome.storage.local.set({ version: VERSION });
  chrome.alarms.create("update-check", { periodInMinutes: 1 });
  await checkUpdate();
})().catch(e => console.error("update check", e));

// A reload leaves the pages open before it with content scripts that no longer reach the
// extension: each http page gets this build's detect.js again. Right after a reload a page may not
// take the script yet, so pages still without it are tried again a few times.
async function reinject() {
  const open = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  let missing = 0;
  await Promise.all(open.map(async t => {
    if ((await seenOn(t.id)) !== undefined) return;
    const done = await within(chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["patterns.js", "detect.js"] }), 5_000).then(() => true, () => false);
    if (!done || (await seenOn(t.id)) === undefined) missing++;
  }));
  return missing;
}
restored.then(async () => {
  for (const wait of [0, 1_000, 3_000, 8_000]) {
    await pause(wait);
    if (!(await reinject().catch(() => 1))) break;
  }
}).catch(() => {});

chrome.runtime.onStartup.addListener(() => drawDefault().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => drawDefault().catch(() => {}));

// For the end-to-end tests: one solve asked from outside, and what the worker holds.
globalThis.neulandSolve = async tab => {
  const t = await chrome.tabs.get(tab);
  return consider(tab, t.url, (await seenOn(tab)) ?? null, true);
};
globalThis.neucapRuns = () => [...runs.values()].map(r => ({ tab: r.tab, halted: r.halted, attached: r.attached }));
