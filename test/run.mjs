// End-to-end run of the built extension (dist/) in a Chromium with no window of its own on the
// person's screen: headless, or headful on an X server of its own (XVFB=:99, an Xvfb). Opens the test
// site's page, lets the extension notice the check by itself, and reports whether the check passed,
// what the extension's log says, how long its service worker lived, and the last commands the solvers
// sent (TRACE=<n> of them, 60 by default).
//
//   node test/run.mjs <chrome> <page url> [<seconds to wait>]
import puppeteer from "puppeteer-core";
import path from "node:path";

const [chrome, url, wait = "120"] = process.argv.slice(2);
const dist = process.env.EXTENSION ?? path.resolve(import.meta.dirname, "../dist");
// Headful only on an X server of the test's own (XVFB=:<n>), never on the person's screen.
const headful = !!process.env.XVFB;
if (headful && process.env.XVFB === process.env.DISPLAY) throw new Error("XVFB is the person's own display");
const env = { ...process.env, DISPLAY: process.env.XVFB ?? "" };
delete env.WAYLAND_DISPLAY;
delete env.NIXOS_OZONE_WL;
const browser = await puppeteer.launch({ protocolTimeout: 30000, ignoreDefaultArgs: ["--enable-automation"],
  executablePath: chrome, headless: !headful, enableExtensions: [dist], pipe: true, env,
  args: ["--no-sandbox", "--ozone-platform=x11", "--enable-unsafe-webgpu", "--window-size=1200,900", ...(process.env.CHROME_ARGS ?? "").split(" ").filter(Boolean)],
  defaultViewport: null,
});
const started = Date.now();
const at = () => ((Date.now() - started) / 1000).toFixed(1);
const events = [];
browser.on("targetcreated", t => t.type() === "service_worker" && events.push(`${at()}s worker up`));
browser.on("targetdestroyed", t => t.type() === "service_worker" && events.push(`${at()}s worker gone`));

// The worker's console, for what went wrong where nothing passes.
const lines = [];
const listen = async t => {
  const w = await t.worker().catch(() => null);
  if (!w) return;
  w.on("console", m => lines.push(`${at()}s ${m.type()} ${m.text()}`));
  w.on("error", e => lines.push(`${at()}s error ${e}`));
};
// A worker DevTools is attached to is never stopped, so with IDLE (a look at the worker's lifetime)
// nothing attaches before the idle wait is over.
if (!process.env.IDLE) {
  browser.on("targetcreated", t => t.type() === "service_worker" && listen(t));
  for (const t of browser.targets()) if (t.type() === "service_worker") { events.push(`${at()}s worker up`); listen(t); }
}

const page = await browser.newPage();
await page.goto(url);
const passed = async () => {
  for (const f of page.frames()) {
    if (!/anchor|checkbox|turnstile|captcha/.test(f.url())) continue;
    const done = await f.evaluate(() => {
      const box = document.querySelector("#recaptcha-anchor, [role=checkbox]");
      return box ? box.getAttribute("aria-checked") === "true" : false;
    }).catch(() => false);
    if (done) return true;
  }
  return page.evaluate(() => !!window.PASSED).catch(() => false);
};
let ok = false;
const until = Date.now() + Number(wait) * 1000;
let screens = 0;
while (Date.now() < until && !(ok = await passed())) {
  await new Promise(r => setTimeout(r, 1000));
  // The screen while the extension works, debugger bar and all, every 20 s.
  if (headful && process.env.SCREEN && Date.now() - started > 20000 * (screens + 1)) {
    const { execSync } = await import("node:child_process");
    execSync(`import -display ${process.env.XVFB} -window root ${process.env.SCREEN}-${screens++}.png`);
  }
}
events.push(`${at()}s ${ok ? "passed" : "still standing"}`);
if (process.env.IDLE) {
  // How long the worker stays once nothing asks it anything.
  await new Promise(r => setTimeout(r, Number(process.env.IDLE) * 1000));
  events.push(`${at()}s after idle wait, worker ${browser.targets().some(t => t.type() === "service_worker") ? "still there" : "stopped"}`);
}
// The log the extension keeps of its last solve, read once it has written it.
events.push(`targets ${browser.targets().map(t => `${t.type()} ${t.url()}`).join(" | ")}`);
const target = browser.targets().find(t => t.type() === "service_worker");
const worker = target ? await target.worker() : null;
let log = null;
for (let i = 0; i < 90 && !log; i++) {
  log = await worker?.evaluate(() => chrome.storage.local.get(null)).catch(() => null);
  if (log && !Object.keys(log).length) log = null;
  if (!log) await new Promise(r => setTimeout(r, 1000));
}
// The screen once the extension let go of the tab.
if (headful && process.env.SCREEN) {
  const { execSync } = await import("node:child_process");
  execSync(`import -display ${process.env.XVFB} -window root ${process.env.SCREEN}-end.png`);
}
for (const f of page.frames()) {
  const v = await f.evaluate(() => ({ verdict: window.VERDICT, trusted: window.TRUSTED, selected: document.querySelectorAll(".rc-imageselect-dynamic-selected, .rc-image-tile-11").length })).catch(() => undefined);
  events.push(`${f.url().slice(0, 60)} ${JSON.stringify(v)}`);
}
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }).catch(e => events.push(`no screenshot: ${e.message}`));
const trace = await worker?.evaluate(n => globalThis.neulandTrace?.slice(-n), Number(process.env.TRACE ?? 60)).catch(() => null);
console.log(JSON.stringify({ ok, events, log, console: lines.filter(l => !/onnxruntime|execution provider/.test(l)), trace }, null, 1));
await browser.close();
process.exit(ok ? 0 : 1);
