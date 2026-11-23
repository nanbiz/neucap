// Tells the extension when the page shows a check it may answer: one of the vendors' frames or
// boxes appearing, now or later (a challenge a form's button opens), with the vendor it belongs
// to, as patterns.js lists them. The page itself is never touched from here; the service worker
// decides and acts. A site turned off, or NeuCap paused, is told as seen only, so the worker
// records it without taking the tab's debugger; the worker checks the same settings again before
// any solve.
(() => {
  const PATTERNS = globalThis.NEUCAP_PATTERNS;
  const drawn = f => f.offsetWidth > 0 && f.offsetHeight > 0 && getComputedStyle(f).visibility !== "hidden";
  /** The vendor whose check the page shows, or null. */
  const shown = () => {
    for (const f of document.querySelectorAll("iframe")) {
      const src = f.src || "";
      for (const p of PATTERNS) if (p.frame?.test(src) || (p.shownFrame?.test(src) && drawn(f))) return p.vendor;
    }
    for (const p of PATTERNS) if (p.selector && document.querySelector(p.selector)) return p.vendor;
    return null;
  };
  // The popup asks this when it opens, for a tab the worker has nothing on.
  globalThis.neucapShown = shown;

  const host = location.hostname;
  /** Whether a solve may start here, as far as the page's own settings tell. */
  const allowed = async () => {
    const got = await chrome.storage.local.get([`mode:${host}`, "defaultMode", "pause"]).catch(() => ({}));
    const mode = got[`mode:${host}`] ?? got.defaultMode ?? "auto";
    const paused = got.pause && (got.pause.until === null || got.pause.until > Date.now());
    return mode !== "off" && !paused;
  };
  let told = 0;
  const tell = async vendor => {
    const now = Date.now();
    if (now - told < 3000) return;
    told = now;
    const message = (await allowed()) ? { captcha: true, vendor } : { seen: true, vendor };
    chrome.runtime.sendMessage(message).catch(() => {});
  };
  const look = () => {
    const vendor = shown();
    if (vendor) tell(vendor);
  };
  look();
  new MutationObserver(look).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "style", "class"] });
})();
