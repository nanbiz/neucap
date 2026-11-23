// What the worker, the popup and the options page share: the vendors and their checks, the keys
// settings are kept under, and how a tab's state reads.

/** Each vendor the extension knows, the checks the solvers name for it (solver.names()), the
 * networks those need, and the markup or frame address detect.js knows it by. */
export const VENDORS = [
  { id: "recaptcha", name: "reCAPTCHA", checks: ["recaptcha"], models: ["clip-vit-b32-vision", "yolox_s"] },
  { id: "hcaptcha", name: "hCaptcha", checks: ["hcaptcha"], models: ["hcaptcha_identical"] },
  { id: "turnstile", name: "Turnstile", checks: ["turnstile"], models: [] },
  { id: "perimeterx", name: "PerimeterX", checks: ["perimeterx"], models: [] },
  { id: "yandex", name: "Yandex SmartCaptcha", checks: ["yandex-puzzle", "yandex-checkbox"], models: ["yandex_symbols", "yandex_centres", "yandex_match_icon", "yandex_match_crop", "yandex_text_enc", "yandex_text_step"] },
  { id: "brave", name: "Brave slider", checks: ["brave"], models: [] },
  { id: "geetest", name: "GeeTest", checks: ["geetest"], models: [] },
  { id: "datadome", name: "DataDome", checks: ["datadome"], models: [] },
  { id: "arkose", name: "Arkose", checks: ["arkose"], models: ["arkose_yaw"] },
  { id: "altcha", name: "ALTCHA", checks: ["altcha"], models: [] },
  { id: "friendly", name: "Friendly Captcha", checks: ["friendly-captcha"], models: [] },
];

/** The names a check of several in one vendor goes by. */
export const CHECK_LABELS = { "yandex-puzzle": "Puzzle", "yandex-checkbox": "Checkbox" };

export const vendorById = id => VENDORS.find(v => v.id === id) ?? null;
export const vendorOfCheck = name => VENDORS.find(v => v.checks.includes(name)) ?? null;

/** The networks the worker can load, by model file name. */
export const MODELS = [
  "hcaptcha_identical", "yandex_symbols", "yandex_centres", "yandex_match_icon", "yandex_match_crop",
  "yandex_text_enc", "yandex_text_step", "clip-vit-b32-vision", "yolox_s", "arkose_yaw",
];

/** A site's own mode, kept as `mode:<host>`; sites without one follow `defaultMode`. */
export const MODES = ["auto", "ask", "off"];
export const modeKey = host => `mode:${host}`;
/** A check turned off, kept as `off:<check name>`. */
export const offKey = check => `off:${check}`;
/** A tab's state as the worker reports it, in chrome.storage.session. */
export const tabKey = tab => `tab:${tab}`;
export const HISTORY_KEPT = 1000;

/** The phases the worker writes for a tab. Any other string is shown as unknown. */
export const PHASES = ["found", "off", "paused", "solving", "solved", "failed", "stopped", "unsupported", "interrupted"];

/** Outcomes a finished solve is kept with in the history. */
export const FAILED = new Set(["standing", "error", "nothing", "interrupted"]);
/** The history's groups, the same in the popup and the options page: passed, not passed (failed,
 * stopped, tab closed) and no reader. */
export const GROUPS = {
  all: () => true,
  passed: h => h.outcome === "passed",
  failed: h => FAILED.has(h.outcome) || h.outcome === "stopped" || h.outcome === "closed",
  unsupported: h => h.outcome === "unsupported",
};

/** How the history shows each outcome: colour, icon (the popup's state icons, in a circle) and
 * what it is. */
export const OUTCOMES = {
  passed: ["ok", "circle-check", "Passed"],
  standing: ["bad", "circle-x", "Failed: still standing"],
  nothing: ["bad", "circle-x", "Failed: nothing to act on"],
  error: ["bad", "circle-x", "Failed on an error"],
  interrupted: ["bad", "circle-alert", "Interrupted: the worker stopped"],
  unsupported: ["warn", "circle-help", "No reader for this check"],
  stopped: ["dim", "circle-stop", "Stopped"],
  closed: ["dim", "circle-stop", "Tab closed during the solve"],
};
export const outcomeOf = o => OUTCOMES[o] ?? ["dim", "circle-dashed", `Unknown: ${o}`];

/** Where a solve's networks ran, as the history keeps it: GPU, CPU, none (no network ran) or
 * unknown (several solves ran networks at once, or the worker that ran them stopped). */
export const RAN = {
  GPU: ["GPU", "zap", "GPU", "Its networks ran on the GPU (WebGPU)"],
  CPU: ["CPU", "cpu", "CPU", "Its networks ran on the CPU"],
  none: ["idle", "circle-off", "none", "No network ran"],
  unknown: ["idle", "circle-dashed", "unknown", "Not known which networks ran"],
};
export const ranOf = r => RAN[r] ?? RAN.unknown;

export const hostOf = url => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
};

/** Whether NeuCap is paused now: `pause` holds { until } (null until resumed), or the browser
 * session holds `pauseSession` (until the browser restarts). */
export async function pausedUntil() {
  const [{ pause }, { pauseSession }] = await Promise.all([chrome.storage.local.get("pause"), chrome.storage.session.get("pauseSession")]);
  if (pauseSession) return "restart";
  if (!pause) return false;
  if (pause.until === null) return "resumed";
  return pause.until > Date.now() ? pause.until : false;
}

export async function modeOf(host) {
  const key = modeKey(host);
  const got = await chrome.storage.local.get([key, "defaultMode"]);
  return got[key] ?? got.defaultMode ?? "auto";
}

export const fmtClock = t => new Date(t).toTimeString().slice(0, 5);
export const fmtClockSec = t => new Date(t).toTimeString().slice(0, 8);
export const fmtElapsed = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const fmtDay = t => {
  const d = new Date(t), now = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 864e5);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
};
