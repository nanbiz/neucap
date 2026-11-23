// The options page: the pause and defaults, every site with its own mode, the checks and their
// switches, the networks and where they run, the whole history with its export, and the keyboard
// shortcuts. Everything is read from storage and the worker, and redrawn when either changes.
import { SVG } from "./icons.js";
import { CHECK_LABELS, GROUPS, MODELS, VENDORS, fmtClock, fmtDay, modeKey, offKey, outcomeOf, pausedUntil, ranOf, vendorById } from "./common.js";

const ic = (name, size = 16, cls = "") =>
  `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[name] ?? ""}</svg>`;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ask = m => chrome.runtime.sendMessage(m);
const main = document.getElementById("main");
const nav = document.getElementById("nav");

const MODE = [["auto", "Auto", "zap"], ["ask", "Ask", "hand"], ["off", "Off", "ban"]];
const seg = (mode, attr) => `<div class="seg" role="radiogroup">${MODE.map(([k, t, i]) => `<button ${attr}="${k}" class="${k === mode ? "sel " + k : ""}" aria-checked="${k === mode}" role="radio">${ic(i, 13)}${t}</button>`).join("")}</div>`;
const PAUSES = [[900_000, "15 min"], [3_600_000, "1 h"], ["restart", "Until restart"], ["resumed", "Until resumed"]];

// What only the worker knows, asked once: the checks its solvers carry and the networks it has.
const worker = await ask({ ask: "names" }).catch(e => ({ error: String(e) }));
const names = new Set(worker?.names ?? []);
const carried = new Set(worker?.models ?? []);
// Each network's size, as the build read it from the model files.
const sizes = worker?.sizes ?? {};
const webgpu = await (navigator.gpu?.requestAdapter().then(a => !!a).catch(() => false) ?? false);
let filter = "all", adding = false;

function general(local, paused) {
  const pauseFor = local.pauseFor ?? 3_600_000;
  const chip = paused ? `<span class="state warn">${ic("pause", 12)}${typeof paused === "number" ? fmtClock(paused) : paused === "restart" ? "Until restart" : "Until resumed"}</span>` : "";
  return `<section id="general"><h3>General</h3><div class="card">
    <div class="row"><span class="lb">${ic("power", 16)}NeuCap</span>${chip}<button class="sw ${paused ? "" : "on"}" id="power" role="switch" aria-checked="${!paused}" title="${paused ? "Resumes NeuCap everywhere" : "Pauses NeuCap everywhere, for as long as a pause lasts"}"></button></div>
    <div class="row"><span class="lb">${ic("timer", 16)}A pause lasts</span><div class="seg" role="radiogroup">${PAUSES.map(([v, t]) => `<button data-pause="${v}" role="radio" aria-checked="${v === pauseFor}" class="${v === pauseFor ? "sel auto" : ""}">${t}</button>`).join("")}</div></div>
    <div class="row"><span class="lb">${ic("globe", 16)}Sites not listed</span>${seg(local.defaultMode ?? "auto", "data-default")}</div>
    <div class="row"><span class="lb">${ic("cpu", 16)}Run networks on</span><div class="seg">${[["auto", "Auto"], ["gpu", "GPU"], ["cpu", "CPU"]].map(([k, t]) => `<button data-compute="${k}" class="${(local.compute ?? "auto") === k ? "sel auto" : ""}">${t}</button>`).join("")}</div></div>
    <div class="row"><span class="lb">${ic("bell", 16)}Notify when a solve fails</span><button class="sw ${local.notify === false ? "" : "on"}" id="notify" role="switch" aria-checked="${local.notify !== false}"></button></div>
  </div></section>`;
}

function sites(local, history) {
  const list = Object.entries(local).filter(([k]) => k.startsWith("mode:")).map(([k, mode]) => ({ host: k.slice(5), mode })).sort((a, b) => a.host.localeCompare(b.host));
  const count = host => history.filter(h => h.host === host).length;
  const rows = list.map(s => `<tr><td class="mono">${esc(s.host)}</td><td>${seg(s.mode, `data-site="${esc(s.host)}" data-mode`)}</td><td class="num">${count(s.host)}</td>
    <td style="width:40px"><button class="ib" data-forget="${esc(s.host)}" title="Removes this site's own mode">${ic("trash-2", 14)}</button></td></tr>`);
  if (adding) rows.unshift(`<tr><td><input class="addhost" id="newhost" placeholder="www.example.com"></td><td>${seg(null, "data-newmode")}</td><td></td><td></td></tr>`);
  if (!rows.length) rows.push(`<tr><td colspan="4" class="empty-row">${ic("globe", 18)}</td></tr>`);
  return `<section id="sites"><h3>Sites<span class="grow"></span><button class="btn small" id="add">${ic("plus", 13)}Add site</button></h3><div class="card"><table class="tbl">
    <tr><th>Site</th><th>Mode</th><th class="num">Solves</th><th></th></tr>${rows.join("")}</table></div></section>`;
}

function checks(local, history) {
  const rows = VENDORS.map(v => {
    const have = v.checks.filter(c => names.has(c));
    const on = have.filter(c => !local[offKey(c)]);
    const l = history.filter(h => h.vendor === v.id && h.outcome !== "unsupported");
    const p = l.filter(h => h.outcome === "passed").length;
    const rate = l.length ? `<div class="rate"><div class="bar"><b style="width:${p / l.length * 100}%"></b></div>${p}/${l.length}</div>` : `<div class="rate"></div>`;
    // Each check of a vendor with several has its own switch; chips only name the networks.
    const checksOf = have.length && v.checks.length > 1 ? `<div class="checks">${have.map(c => `<span class="ck">${CHECK_LABELS[c] ?? c}<button class="sw mini ${local[offKey(c)] ? "" : "on"}" data-check="${c}" role="switch" aria-checked="${!local[offKey(c)]}" title="${local[offKey(c)] ? `Turns ${CHECK_LABELS[c] ?? c} on` : `Turns ${CHECK_LABELS[c] ?? c} off`}"></button></span>`).join("")}</div>` : "";
    let nets;
    if (!have.length) {
      const missing = v.models.filter(m => !carried.has(m));
      nets = `<span class="kd miss" title="The solvers carry no reader for it">${ic("circle-off", 11)}${missing.length ? `no ${missing.join(", ")}` : "no reader"}</span>`;
    } else if (v.models.length > 2) nets = `<span class="kd" title="${v.models.join(", ")}">${ic("cpu", 11)}${v.models.length} networks</span>`;
    else if (v.models.length) nets = v.models.map(m => `<span class="kd" title="Network this reader runs">${ic("cpu", 11)}${m}</span>`).join("");
    else nets = `<span class="kd" title="This reader runs no network">${ic("circle-off", 11)}no network</span>`;
    const kinds = checksOf + nets;
    return `<div class="row ${have.length && !on.length ? "offrow" : ""}"><span class="lb" style="flex:0 0 190px">${v.name}</span><div class="kinds">${kinds}</div>${rate}
      <button class="sw ${on.length ? "on" : ""}" data-vendor="${v.id}" ${have.length ? "" : "disabled"} role="switch" aria-checked="${!!on.length}" title="${on.length ? `Turns ${v.name} off` : `Turns ${v.name} on`}"></button></div>`;
  });
  const fail = worker?.error ? `<div class="row"><span class="err" style="flex:1">${esc(worker.error)}</span></div>` : "";
  return `<section id="checks"><h3>Checks</h3><div class="card">${fail}${rows.join("")}</div></section>`;
}

function models(state) {
  const usedBy = n => VENDORS.filter(v => v.models.includes(n)).map(v => v.name.split(" ")[0]).join(", ");
  // The networks ship in the extension: "ready" is on disk and not in memory yet.
  const ST = {
    webgpu: `<span class="prov webgpu">${ic("memory-stick", 11)}in memory (GPU)</span>`, cpu: `<span class="prov cpu">${ic("memory-stick", 11)}in memory (CPU)</span>`,
    opening: `<span class="prov idle">${ic("loader-circle", 11, "spin")}preparing</span>`, idle: `<span class="prov idle">${ic("hard-drive", 11)}ready</span>`,
  };
  const rows = MODELS.map(n => {
    const m = state[n] ?? {};
    const st = m.st ?? "idle";
    const cell = !carried.has(n) ? `<span class="kd miss">${ic("circle-off", 11)}not carried</span>`
      : st === "loading" ? `<div class="mrow"><span class="prov idle">${ic("loader-circle", 11, "spin")}loading ${m.pct ?? 0} %</span><div class="bar"><b style="width:${m.pct ?? 0}%"></b></div></div>`
      : st === "failed" ? `<span class="prov failed" title="${esc(m.error)}">${ic("triangle-alert", 11)}failed</span>` : ST[st] ?? `<span class="prov idle">${esc(st)}</span>`;
    const fell = m.fell ? ` <span class="kd" title="Stalled on WebGPU, moved to the CPU">${ic("triangle-alert", 11)}GPU stalled</span>` : "";
    const act = !carried.has(n) ? "" : st === "idle" || st === "failed" ? `<button class="ib" data-load="${n}" title="Load into memory now, before a check needs it">${ic("memory-stick", 15)}</button>`
      : st === "webgpu" || st === "cpu" ? `<button class="ib" data-release="${n}" title="Let go: frees its memory; the next check that needs it loads it again">${ic("x", 15)}</button>` : "";
    return `<tr><td class="mono">${n}</td><td>${usedBy(n)}</td><td class="num">${sizes[n] ? (sizes[n] / 1048576).toFixed(1) + " MB" : ""}</td><td>${cell}${fell}</td><td class="num">${m.ms ? (m.ms / 1000).toFixed(1) + " s" : ""}</td><td style="width:40px">${act}</td></tr>`;
  });
  return `<section id="models"><h3>Models<span class="grow"></span>${webgpu ? `<span class="state ok">${ic("zap", 12)}WebGPU available</span>` : `<span class="state off">${ic("cpu", 12)}No WebGPU</span>`}</h3>
    <div class="card"><table class="tbl"><tr><th>Network</th><th>Used by</th><th class="num">Size</th><th>State</th><th class="num">Took to load</th><th></th></tr>${rows.join("")}</table></div></section>`;
}

const groups = GROUPS;
function historySection(history) {
  const count = k => history.filter(groups[k]).length;
  const chip = (k, inner) => `<button class="chip ${filter === k ? "sel" : ""}" data-filter="${k}">${inner}<span class="c">${count(k)}</span></button>`;
  const shown = history.filter(groups[filter]);
  const rows = shown.map(h => {
    const [col, icon, said] = outcomeOf(h.outcome);
    const [rc, ri, rt, rsaid] = ranOf(h.ran);
    const vendor = h.vendor ? vendorById(h.vendor)?.name ?? h.vendor : "Unknown";
    const att = `<div class="att" title="${h.attempts?.length ?? 0} attempts">${[0, 1, 2].map(i => `<i style="width:10px" class="${h.attempts?.[i]?.r ?? ""}"></i>`).join("")}</div>`;
    return `<tr><td class="num" style="text-align:left;white-space:nowrap">${fmtDay(h.at) === "Today" ? "" : fmtDay(h.at) + " "}${fmtClock(h.at)}</td><td class="mono">${esc(h.host)}</td>
      <td>${esc(vendor)}${h.check && CHECK_LABELS[h.check] ? ` <span class="kd">${CHECK_LABELS[h.check]}</span>` : ""}</td><td>${att}</td><td class="num">${((h.ms ?? 0) / 1000).toFixed(1)} s</td>
      <td><span class="prov ${rc}" title="${rsaid}">${ic(ri, 11)}${rt}</span></td><td title="${esc(said)}${h.error ? `: ${esc(h.error)}` : ""}" style="color:var(--${col})">${ic(icon, 15)}</td></tr>`;
  });
  if (!rows.length) rows.push(`<tr><td colspan="7" class="empty-row">${ic("history", 18)}</td></tr>`);
  return `<section id="history"><h3>History<span class="grow"></span><div class="chips">${chip("all", "All ")}${chip("passed", ic("check", 12))}${chip("failed", ic("x", 12))}${chip("unsupported", ic("circle-help", 12))}</div>
    <button class="btn small" id="export" title="Saves the history, the settings and the worker's last commands as a file">${ic("download", 13)}Export with trace</button>
    <button class="btn small" id="clear" title="Deletes every kept solve">${ic("trash-2", 13)}Clear</button></h3>
    <div class="card hscroll"><table class="tbl"><tr><th>Time</th><th>Site</th><th>Check</th><th>Attempts</th><th class="num">Took</th><th>Ran on</th><th>Outcome</th></tr>${rows.join("")}</table></div></section>`;
}

async function shortcuts() {
  const all = await chrome.commands.getAll();
  const icon = { "solve-tab": "play", "cycle-mode": "shield-off" };
  const rows = all.filter(c => icon[c.name]).map(c => `<div class="row"><span class="lb">${ic(icon[c.name], 16)}${esc(c.description)}</span>
    ${c.shortcut ? c.shortcut.split("+").map(k => `<span class="kbd">${esc(k)}</span>`).join("") : `<span class="kd miss">${ic("circle-off", 11)}none</span>`}</div>`);
  return `<section id="shortcuts"><h3>Shortcuts<span class="grow"></span><button class="btn small" id="keys" title="Opens the browser's page for changing shortcuts">${ic("keyboard", 13)}Change</button></h3><div class="card">${rows.join("")}</div></section>`;
}

let drawing = false, again = false;
async function draw() {
  if (drawing) { again = true; return; }
  drawing = true;
  try {
    const [local, { models: state = {} }, paused] = await Promise.all([chrome.storage.local.get(null), chrome.storage.session.get("models"), pausedUntil()]);
    const history = local.history ?? [];
    const scroll = document.querySelector(".hscroll")?.scrollTop ?? 0;
    const sitesCount = Object.keys(local).filter(k => k.startsWith("mode:")).length;
    const NAV = [["general", "sliders-horizontal", "General"], ["sites", "globe", "Sites", sitesCount], ["checks", "puzzle", "Checks", VENDORS.length], ["models", "cpu", "Models", MODELS.length], ["history", "history", "History", history.length], ["shortcuts", "keyboard", "Shortcuts"]];
    const here = (location.hash || "#general").slice(1);
    nav.innerHTML = `<div class="brand"><img src="../icons/neucap-32.png" width="18" height="18" alt="">NeuCap <span class="kchip" style="margin-left:auto">${chrome.runtime.getManifest().version}</span></div>`
      + NAV.map(([id, i, t, c]) => `<a href="#${id}" class="${id === here ? "sel" : ""}">${ic(i, 16)}${t}${c !== undefined ? `<span class="c">${c}</span>` : ""}</a>`).join("");
    const keep = adding ? document.getElementById("newhost")?.value ?? "" : "";
    main.innerHTML = general(local, paused) + sites(local, history) + checks(local, history) + models(state) + historySection(history) + await shortcuts();
    const hs = document.querySelector(".hscroll");
    if (hs) hs.scrollTop = scroll;
    if (adding) { const n = document.getElementById("newhost"); n.value = keep; n.focus(); }
  } finally {
    drawing = false;
    if (again) { again = false; draw(); }
  }
}

main.addEventListener("click", async e => {
  const el = e.target.closest("button");
  if (!el || el.disabled) return;
  const d = el.dataset;
  if (el.id === "power") {
    if (await pausedUntil()) await ask({ ask: "resume" });
    else await ask({ ask: "pause", for: (await chrome.storage.local.get("pauseFor")).pauseFor ?? 3_600_000 });
  } else if (d.pause) {
    await chrome.storage.local.set({ pauseFor: /^\d+$/.test(d.pause) ? Number(d.pause) : d.pause });
  } else if (d.default) await chrome.storage.local.set({ defaultMode: d.default });
  else if (d.compute) await chrome.storage.local.set({ compute: d.compute });
  else if (el.id === "notify") await chrome.storage.local.set({ notify: !el.classList.contains("on") });
  else if (d.site && d.mode) await chrome.storage.local.set({ [modeKey(d.site)]: d.mode });
  else if (d.forget) await chrome.storage.local.remove(modeKey(d.forget));
  else if (el.id === "add") { adding = !adding; draw(); }
  else if (d.newmode) {
    const host = document.getElementById("newhost").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!host) return document.getElementById("newhost").focus();
    adding = false;
    await chrome.storage.local.set({ [modeKey(host)]: d.newmode });
  } else if (d.vendor) {
    const v = vendorById(d.vendor);
    const on = el.classList.contains("on");
    const keys = v.checks.filter(c => names.has(c)).map(offKey);
    if (on) await chrome.storage.local.set(Object.fromEntries(keys.map(k => [k, true])));
    else await chrome.storage.local.remove(keys);
  } else if (d.check) {
    const k = offKey(d.check);
    if (el.classList.contains("offk")) await chrome.storage.local.remove(k);
    else await chrome.storage.local.set({ [k]: true });
  } else if (d.load) ask({ ask: "load", model: d.load }).catch(() => {});
  else if (d.release) await ask({ ask: "release", model: d.release });
  else if (d.filter) { filter = d.filter; draw(); }
  else if (el.id === "clear") await ask({ ask: "clear" });
  else if (el.id === "export") {
    const data = await ask({ ask: "export" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
    a.download = `neucap-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } else if (el.id === "keys") chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});
main.addEventListener("keydown", e => {
  if (e.target.id === "newhost" && e.key === "Escape") { adding = false; draw(); }
});
addEventListener("hashchange", () => draw());
chrome.storage.onChanged.addListener(() => draw());
await draw();
document.getElementById(location.hash.slice(1))?.scrollIntoView();
