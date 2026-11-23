// NeuCap updating itself without a browser restart, as pc0 runs it: Chromium loads the extension
// with --load-extension from a folder a new build is moved into (the folder is a real one:
// Chromium resolves a link to the folder it points at and keeps that), in a profile with
// developer mode on, without which Chromium disables an extension from the command line once it
// reloads (DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION). The test site (test/site.mjs) must be
// serving.
//
//   1. the folder holds the build; a PerimeterX solve starts
//   2. during the solve the folder is replaced by a build of a higher version and the popup opens
//      (which has the worker look at the files): the solve is not cut and passes
//   3. once it ended the worker reloads into the new build: the new version runs, the update is
//      kept for the popup, the history is kept, a page open before it is detected again and a
//      check there is answered
//
//   node test/update.mjs <chromium> <extension folder> [<picture folder>]
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [chrome, build, shots] = process.argv.slice(2);
const SITE = "http://127.0.0.1:8777";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "neucap-update-"));
const folder = path.join(work, "neucap");
const copy = (from, to) => execFileSync("cp", ["-a", "--reflink=auto", `${from}/.`, to]);
fs.mkdirSync(folder);
copy(build, folder);
execFileSync("chmod", ["-R", "u+w", folder]);
const profile = path.join(work, "profile");
fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
const before = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")).version;
const after = `${before}.1`;

async function until(what, check, ms = 30000, every = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    let failed = false;
    last = await check().catch(e => { failed = true; return String(e); });
    if (last && !failed) return last;
    await sleep(every);
  }
  throw new Error(`${what}: not within ${ms} ms (last ${JSON.stringify(last)})`);
}
const assert = (ok, what) => { if (!ok) throw new Error(what); };

const env = { ...process.env, DISPLAY: "" };
delete env.WAYLAND_DISPLAY;
const browser = await puppeteer.launch({
  executablePath: chrome, headless: true, pipe: true, env, userDataDir: profile, defaultViewport: null, protocolTimeout: 60000,
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
  args: ["--no-sandbox", `--load-extension=${folder}`, `--disable-extensions-except=${folder}`],
});
const result = { before, after };
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().endsWith("/sw.js"), { timeout: 30000 });
  const id = new URL(sw.url()).host;
  const control = async () => {
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${id}/ui/options.html`);
    return p;
  };
  let page = await control();
  result.versionBefore = await page.evaluate(() => chrome.runtime.getManifest().version);
  assert(result.versionBefore === before, `running ${result.versionBefore}`);
  const state = (p, tab) => p.evaluate(k => chrome.storage.session.get(k).then(r => r[k] ?? null), `tab:${tab}`);
  const tabOf = (p, url) => until("tab", () => p.evaluate(u => chrome.tabs.query({}).then(ts => ts.find(t => t.url === u)?.id ?? null), url));

  // A page in Ask, open across the update.
  await page.evaluate(() => chrome.storage.local.set({ "mode:localhost": "ask", notify: false }));
  const waiting = await browser.newPage();
  await waiting.goto(`${SITE.replace("127.0.0.1", "localhost")}/turnstile.html`);
  const waitingTab = await tabOf(page, `${SITE.replace("127.0.0.1", "localhost")}/turnstile.html`);
  await until("found", () => state(page, waitingTab).then(s => (s?.phase === "found" ? s : null)), 15000);

  // 1, 2: a solve, and the folder replaced during it.
  const solving = await browser.newPage();
  await solving.goto(`${SITE}/perimeterx.html`);
  const tab = await tabOf(page, `${SITE}/perimeterx.html`);
  await until("holding", () => state(page, tab).then(s => (s?.step === "attempt" ? s : null)), 30000, 100);
  const next = path.join(work, "neucap.next");
  fs.mkdirSync(next);
  copy(build, next);
  execFileSync("chmod", ["-R", "u+w", next]);
  const manifest = JSON.parse(fs.readFileSync(path.join(next, "manifest.json"), "utf8"));
  fs.writeFileSync(path.join(next, "manifest.json"), JSON.stringify({ ...manifest, version: after }, null, 2));
  fs.renameSync(folder, `${folder}.old`);
  fs.renameSync(next, folder);
  fs.rmSync(`${folder}.old`, { recursive: true, force: true });
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${id}/ui/popup.html?tab=${tab}`);
  await sleep(1500);
  result.duringSolve = await state(page, tab).then(s => s?.phase).catch(e => `gone: ${e.message}`);
  assert(result.duringSolve === "solving", `the solve after the new build was seen: ${result.duringSolve}`);
  await until("passed", () => solving.evaluate(() => !!window.PASSED), 30000);
  result.solvePassed = true;

  // 3: the reload once the solve ended.
  const reloadedAt = Date.now();
  page = await until("new build running", async () => {
    const p = await control();
    const v = await p.evaluate(() => chrome.runtime.getManifest().version).catch(() => null);
    if (v === after) return p;
    await p.close();
    return null;
  }, 90000, 1000);
  result.reloadedWithinMs = Date.now() - reloadedAt;
  const local = await page.evaluate(() => chrome.storage.local.get(["updated", "history", "version"]));
  result.updated = local.updated;
  assert(local.updated?.from === before && local.updated?.to === after, `update kept as ${JSON.stringify(local.updated)}`);
  result.historyKept = local.history?.length ?? 0;
  assert(local.history?.[0]?.outcome === "passed", "the solve before the update is not in the history");
  // The page open across the update is detected by this build's detect.js, and its check answered.
  result.detectAgain = await until("detect.js again", () => page.evaluate(async t => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: t }, func: () => (typeof globalThis.neucapShown === "function" ? globalThis.neucapShown() ?? "nothing shown" : null) });
    return r?.result || null;
  }, waitingTab), 20000);
  await page.evaluate(t => chrome.runtime.sendMessage({ ask: "solve", tab: t }), waitingTab);
  await until("answered after the update", () => state(page, waitingTab).then(s => (s?.phase === "solved" ? s : null)), 60000);
  result.answeredAfter = true;
  const pop = await browser.newPage();
  await pop.setViewport({ width: 360, height: 600 });
  await pop.goto(`chrome-extension://${id}/ui/popup.html?tab=${waitingTab}`);
  await pop.waitForSelector(".hd");
  result.popupVersion = await pop.$eval(".hd .state.ok", e => e.textContent.trim()).catch(() => null);
  assert(result.popupVersion === after, `popup shows ${result.popupVersion}`);
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    const h = await pop.evaluate(() => document.body.scrollHeight);
    await pop.screenshot({ path: path.join(shots, "popup-updated.png"), clip: { x: 0, y: 0, width: 360, height: Math.min(600, h) } });
  }
  result.ok = true;
} catch (e) {
  result.ok = false;
  result.error = e.message;
} finally {
  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
