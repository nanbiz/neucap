// The popup: the page's check as the worker reports it (chrome.storage.session `tab:<id>`), the
// site's mode, the global pause, and the history. It redraws whenever the worker writes. A tab the
// worker has nothing on is asked directly whether it shows a check; where it cannot be asked, the
// popup says it does not know.
import { SVG } from "./icons.js";
import { CHECK_LABELS, GROUPS, PHASES, outcomeOf, ranOf, fmtClock, fmtClockSec, fmtDay, fmtElapsed, hostOf, modeKey, modeOf, pausedUntil, tabKey, vendorById } from "./common.js";

const ic = (name, size = 16, cls = "") =>
  `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[name] ?? ""}</svg>`;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const app = document.getElementById("app");
const ask = m => chrome.runtime.sendMessage(m);

// The popup's tab: the active one, or ?tab=<id> (the end-to-end tests open the popup as a page).
const wanted = new URLSearchParams(location.search).get("tab");
const tab = wanted ? await chrome.tabs.get(Number(wanted)) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
let view = "tab";
let filter = "all", query = "";

const MODE = [["auto", "Auto", "zap"], ["ask", "Ask", "hand"], ["off", "Off", "ban"]];
const seg = (mode, title) => `<div class="seg" role="radiogroup" title="${title}">${MODE.map(([k, t, i]) => `<button data-mode="${k}" role="radio" aria-checked="${k === mode}" class="${k === mode ? "sel " + k : ""}">${ic(i, 13)}${t}</button>`).join("")}</div>`;

/** What the page shows when the worker has nothing on the tab: a vendor, null for none, undefined
 * where the page cannot be asked. */
async function seen() {
  // A script's undefined comes back as null, so the page's own answer is told apart by name.
  const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => (typeof globalThis.neucapShown === "function" ? globalThis.neucapShown() ?? "none" : "absent") }).catch(() => [undefined]);
  const v = r?.result;
  return v === "none" ? null : v === "absent" || v == null ? undefined : v;
}


function header(paused, updated) {
  const version = chrome.runtime.getManifest().version;
  // An update this browser ran is shown for a day after it happened, as the worker recorded it.
  const fresh = updated && updated.to === version && Date.now() - updated.at < 864e5;
  const ver = fresh
    ? `<span class="state ok" title="Updated from ${esc(updated.from)} at ${fmtClock(updated.at)}">${ic("circle-arrow-up", 12)}${esc(version)}</span>`
    : `<span class="kchip" title="NeuCap's version">${esc(version)}</span>`;
  const chip = paused ? `<span class="pausechip" title="Paused everywhere">${ic("pause", 12)}${typeof paused === "number" ? fmtClock(paused) : ""}</span>` : "";
  return `<div class="hd"><img class="logo" src="../icons/neucap-32.png" width="18" height="18" alt=""><span class="name">NeuCap</span>${ver}<span class="sp"></span>${chip}
    <button class="sw ${paused ? "" : "on"}" id="power" role="switch" aria-checked="${!paused}" title="${paused ? "Resumes NeuCap everywhere" : "Pauses NeuCap everywhere"}"></button>
    <button class="ib" id="history" title="Shows the history of solves">${ic("history", 16)}</button>
    <button class="ib" id="settings" title="Opens NeuCap's settings">${ic("settings", 16)}</button></div>`;
}

/** The steps of the solve in `s`, as far as the worker reported them. */
function rail(s, models) {
  const phase = s.phase;
  const ended = ["solved", "failed", "stopped", "interrupted"].includes(phase);
  const rows = [];
  const row = (cls, icon, t, m = "", sub = "") => rows.push(`<div class="st ${cls}"><div class="dot">${ic(icon, 12)}</div><div class="t">${t}</div><div class="m">${m}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`);
  row("done", "scan-search", "Found", s.seenAt ? fmtClockSec(s.seenAt) : "");
  if (phase === "found") {
    row("", "bug", "Debugger");
    row("", "mouse-pointer-click", "Attempts");
    row("", "check", "Passed");
    return `<div class="rail">${rows.join("")}</div>`;
  }
  const step = s.step;
  if (phase === "solving" && step === "debugger") row("now", "bug", "Taking the debugger");
  else if (s.attachedAt) row("done", "bug", "Debugger attached", phase === "solving" ? "held" : "released");
  else row("", "bug", "Debugger");
  const of = s.of ?? 0;
  const atts = Array.from({ length: of }, (_, i) => s.attempts?.[i]?.r ?? (phase === "solving" && step === "attempt" && i === s.attempts.length ? "now" : ""));
  let sub = of ? `<div class="att">${atts.map(a => `<i class="${a}"></i>`).join("")}<span class="n">${s.attempt}/${of}</span></div>` : "";
  for (const n of s.models ?? []) {
    const m = models[n] ?? {};
    const right = m.st === "loading" ? `<div class="bar"><b style="width:${m.pct ?? 0}%"></b></div><span>${m.pct ?? 0}%</span>`
      : m.st === "opening" ? `${ic("loader-circle", 12, "spin")}`
      : m.st === "webgpu" ? `<span class="prov GPU">GPU</span>` : m.st === "cpu" ? `<span class="prov CPU">CPU</span>`
      : m.st === "failed" ? `<span class="prov failed">failed</span>` : "";
    sub += `<div class="mrow">${ic("cpu", 12)}<span class="mn">${esc(n)}</span>${right}</div>`;
  }
  // The error's first line; the whole of it on hover and in the history.
  if (s.error) sub += `<div class="err" title="${esc(s.error)}">${esc(String(s.error).split("\n")[0])}</div>`;
  const failed = phase === "failed" || phase === "interrupted";
  if (phase === "solving" && step === "debugger") row("", "mouse-pointer-click", "Attempts");
  else {
    const label = phase === "solving" ? (step === "naming" ? "Reading the check" : step === "attempt" ? `Attempt ${s.attempt}` : "Attempts") : "Attempts";
    const cls = phase === "solving" ? (step === "watching" ? "done" : "now") : failed ? "fail" : phase === "stopped" ? "stop" : "done";
    row(cls, failed ? "x" : "mouse-pointer-click", label, (s.attempts ?? []).map(a => `${a.s}s`).join(" · "), sub);
  }
  if (phase === "solving") row(step === "watching" ? "now" : "", "eye", "Watching page");
  if (phase === "solving") row("", "check", "Passed");
  else if (phase === "solved") row("done", "check", "Passed", s.endedAt ? fmtClockSec(s.endedAt) : "");
  else if (phase === "stopped") row("stop", STOP_ICON[s.reason] ?? "circle-stop", STOP_LABEL[s.reason] ?? "Stopped", s.endedAt ? fmtClockSec(s.endedAt) : "");
  else if (phase === "interrupted") row("fail", "circle-alert", "Interrupted");
  else if (phase === "failed") row("fail", "rotate-ccw", s.outcome === "error" ? "Stopped on error" : s.outcome === "nothing" ? "Nothing to act on" : s.outcome === "standing" ? "Still standing" : `Failed: ${esc(s.outcome)}`);
  if (!ended && phase !== "solving") return "";
  return `<div class="rail">${rows.join("")}</div>`;
}

const STOP_LABEL = { stop: "Stopped", cancelled: "Cancelled on the debugging bar", site: "Site turned off", ask: "Site set to Ask", paused: "Paused", vendor: "Vendor turned off", closed: "Tab closed" };
const STOP_ICON = { cancelled: "x", site: "ban", ask: "hand", paused: "pause", vendor: "ban" };
const CHIP = {
  found: ["warn", "hand", "Waiting"], solving: ["acc", "loader-circle", "Solving"], solved: ["ok", "check", "Solved"],
  failed: ["bad", "x", "Failed"], interrupted: ["bad", "circle-alert", "Interrupted"], stopped: ["off", "circle-stop", "Stopped"],
  paused: ["off", "pause", "Paused"], unsupported: ["warn", "circle-help", "No reader"],
};
const OFF_CHIP = { site: "Not answered", vendor: "Vendor off", check: "Check off" };

function body(s, models, history) {
  const phase = s.phase;
  if (phase === "idle") {
    const today = history.filter(h => fmtDay(h.at) === "Today");
    const ok = today.filter(GROUPS.passed).length, failed = today.filter(GROUPS.failed).length;
    return `<div class="body tall"><div class="empty">${ic("scan-search", 28)}<span class="lbl">No captcha</span>
      <div class="todaybar"><span class="state off">${ic("calendar", 12)}Today</span><span class="state ok" title="Passed today">${ic("check", 12)}${ok}</span><span class="state bad" title="Not passed today">${ic("x", 12)}${failed}</span></div></div></div>`;
  }
  if (phase === "unavailable") return `<div class="body tall"><div class="empty">${ic("circle-off", 28)}<span class="lbl">Not a web page</span></div></div>`;
  const vendor = s.vendor ? vendorById(s.vendor)?.name ?? s.vendor : null;
  const kind = s.check && CHECK_LABELS[s.check];
  const timed = s.startedAt && phase !== "found";
  const head = `<div class="check">${vendor ? `<span class="vchip">${esc(vendor)}</span>` : ""}${kind ? `<span class="kchip">${kind}</span>` : ""}
    <span class="timer">${timed ? `${ic("timer", 12)}<span id="elapsed" data-from="${s.startedAt}" data-to="${s.endedAt ?? ""}">${fmtElapsed((s.endedAt ?? Date.now()) - s.startedAt)}</span>` : ""}</span></div>`;
  let chip;
  if (phase === "off") chip = ["off", "ban", OFF_CHIP[s.reason] ?? "Not answered"];
  else if (phase === "unreported") chip = ["off", "circle-dashed", "Not reported"];
  else if (PHASES.includes(phase)) chip = CHIP[phase];
  else chip = ["off", "circle-dashed", `Unknown: ${esc(phase)}`];
  return `<div class="body">${head}<div><span class="state ${chip[0]}">${ic(chip[1], 12, phase === "solving" ? "spin" : "")}${chip[2]}</span></div>${rail(s, models)}</div>`;
}

function foot(s) {
  const log = `<button class="btn ghost" data-act="log" title="Opens this solve in the history">${ic("scroll-text", 15)}</button>`;
  const F = {
    found: `<button class="btn pri" data-act="solve">${ic("play", 14)}Solve now</button>`,
    unreported: `<button class="btn pri" data-act="solve">${ic("play", 14)}Solve now</button>`,
    solving: `<button class="btn danger" data-act="stop">${ic("square", 13)}Stop</button>`,
    failed: `<button class="btn pri" data-act="solve">${ic("rotate-ccw", 14)}Try again</button>${log}`,
    interrupted: `<button class="btn pri" data-act="solve">${ic("rotate-ccw", 14)}Try again</button>${log}`,
    stopped: `<button class="btn pri" data-act="solve">${ic("rotate-ccw", 14)}Try again</button>${log}`,
    off: `<button class="btn pri" data-act="solve">${ic("play", 14)}Solve once</button>`,
    paused: `<button class="btn pri" data-act="resume">${ic("play", 14)}Resume NeuCap</button>`,
    solved: `<button class="btn quiet" data-act="log">${ic("scroll-text", 14)}Log</button>`,
  };
  return F[s.phase] ? `<div class="foot">${F[s.phase]}</div>` : "";
}

function historyRow(h) {
  const [col, icon, said] = outcomeOf(h.outcome);
  const [rc, ri, rt, rsaid] = ranOf(h.ran);
  const dots = `<div class="att" title="${h.attempts?.length ?? 0} attempts">${[0, 1, 2].map(i => `<i class="${h.attempts?.[i]?.r ?? ""}"></i>`).join("")}</div>`;
  const vendor = h.vendor ? vendorById(h.vendor)?.name ?? h.vendor : "Unknown";
  const kind = h.check && CHECK_LABELS[h.check] ? ` · ${CHECK_LABELS[h.check]}` : "";
  return `<div class="hr"><span class="o" style="color:var(--${col})" title="${esc(said)}">${ic(icon, 15)}</span><span class="h">${esc(h.host)}</span>
    <div class="r">${dots}<span>${((h.ms ?? 0) / 1000).toFixed(1)}s <span class="prov ${rc}" title="${rsaid}">${ic(ri, 11)}${rt}</span></span></div>
    <span class="k">${esc(vendor)}${kind} · ${fmtClock(h.at)}</span></div>`;
}

function historyView(history) {
  const groups = GROUPS;
  const count = k => history.filter(groups[k]).length;
  const q = query.toLowerCase();
  const shown = history.filter(groups[filter]).filter(h => !q || h.host?.toLowerCase().includes(q) || (vendorById(h.vendor)?.name ?? h.vendor ?? "").toLowerCase().includes(q));
  const days = {};
  for (const h of shown) (days[fmtDay(h.at)] ??= []).push(h);
  const list = shown.length
    ? Object.entries(days).map(([d, l]) => `<div class="day"><span>${d}</span><span class="c">${l.filter(h => h.outcome === "passed").length}/${l.length}</span></div>${l.map(historyRow).join("")}`).join("")
    : `<div class="none">${ic("history", 24)}</div>`;
  const chip = (k, inner) => `<button class="chip ${filter === k ? "sel" : ""}" data-filter="${k}">${inner}<span class="c">${count(k)}</span></button>`;
  return `<div class="hd"><button class="ib" id="back" title="Back to this tab">${ic("arrow-left", 16)}</button><span class="name">History</span><span class="sp"></span>
    <button class="ib" data-act="log" title="Opens the full history in settings">${ic("external-link", 15)}</button></div>
    <div class="hbar"><label class="search">${ic("search", 14)}<input id="q" placeholder="Host or vendor" value="${esc(query)}"></label>
    <div class="chips">${chip("all", "All ")}${chip("passed", ic("check", 12))}${chip("failed", ic("x", 12))}${chip("unsupported", ic("circle-help", 12))}</div></div>
    <div class="hlist" id="hl">${list}</div>`;
}

let drawing = false, again = false;
async function draw() {
  if (drawing) { again = true; return; }
  drawing = true;
  try {
    const host = hostOf(tab.url);
    const [session, { history = [], updated }, paused] = await Promise.all([
      chrome.storage.session.get([tabKey(tab.id), "models"]), chrome.storage.local.get(["history", "updated"]), pausedUntil(),
    ]);
    if (view === "history") {
      const scroll = document.getElementById("hl")?.scrollTop ?? 0;
      const focused = document.activeElement?.id === "q";
      app.innerHTML = historyView(history);
      document.getElementById("hl").scrollTop = scroll;
      if (focused) { const q = document.getElementById("q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      return;
    }
    let s = session[tabKey(tab.id)];
    if (!host) s = { phase: "unavailable" };
    else if (!s) {
      const v = await seen();
      s = v === undefined ? { phase: "unknown" } : v === null ? { phase: "idle" } : { phase: "unreported", vendor: v };
    }
    const mode = host ? await modeOf(host) : null;
    const site = host ? `<div class="site"><span class="host">${ic("globe", 14)}<span>${esc(host)}</span></span><div class="${paused ? "dimmed" : ""}">${seg(mode, "This site's mode")}</div></div>` : "";
    app.innerHTML = header(paused, updated) + site + body(s, session.models ?? {}, history) + foot(s);
  } finally {
    drawing = false;
    if (again) { again = false; draw(); }
  }
}

app.addEventListener("click", async e => {
  const el = e.target.closest("button");
  if (!el) return;
  if (el.dataset.mode) {
    await chrome.storage.local.set({ [modeKey(hostOf(tab.url))]: el.dataset.mode });
    return draw();
  }
  if (el.dataset.filter) { filter = el.dataset.filter; return draw(); }
  if (el.id === "power") {
    if (await pausedUntil()) await ask({ ask: "resume" });
    else {
      const { pauseFor = 3_600_000 } = await chrome.storage.local.get("pauseFor");
      await ask({ ask: "pause", for: pauseFor });
    }
    return draw();
  }
  if (el.id === "history") { view = "history"; return draw(); }
  if (el.id === "back") { view = "tab"; return draw(); }
  if (el.id === "settings") return chrome.runtime.openOptionsPage();
  const act = el.dataset.act;
  if (act === "solve") await ask({ ask: "solve", tab: tab.id });
  else if (act === "stop") await ask({ ask: "stop", tab: tab.id });
  else if (act === "resume") await ask({ ask: "resume" });
  else if (act === "log") await chrome.tabs.create({ url: chrome.runtime.getURL("ui/options.html#history") });
});
app.addEventListener("input", e => {
  if (e.target.id === "q") { query = e.target.value; draw(); }
});

await ask({ ask: "hello" }).catch(() => {});
chrome.storage.onChanged.addListener(() => draw());
// The running clock of a solve.
setInterval(() => {
  const el = document.getElementById("elapsed");
  if (el && !el.dataset.to) el.textContent = fmtElapsed(Date.now() - Number(el.dataset.from));
}, 1000);
await draw();
