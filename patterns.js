// How each vendor's check shows on a page, the one list detect.js (a content script, which loads
// this file first) and the service worker (which imports it) both read: `frame` matches a frame's
// address and the page's markup alike, `selector` finds its box in the page, `markup` matches what
// only the markup shows. Arkose counts only as a frame that is drawn, which the markup cannot tell,
// so the worker matches its frame tag and detect.js checks that it is shown.
globalThis.NEUCAP_PATTERNS = [
  { vendor: "recaptcha", frame: /recaptcha\/(api2|enterprise)\/(anchor|bframe)/i },
  { vendor: "hcaptcha", frame: /hcaptcha\.com\/captcha/i },
  { vendor: "turnstile", frame: /challenges\.cloudflare\.com/i, selector: ".cf-turnstile", markup: /cf-turnstile|_cf_chl_opt/i },
  { vendor: "yandex", frame: /smartcaptcha|captcha-api\.yandex/i, selector: "[data-testid=checkbox][class*=Captcha], canvas.captcha-image-canvas, .AdvancedCaptcha", markup: /captcha-image-canvas|AdvancedCaptcha/ },
  { vendor: "geetest", frame: /geetest/i, selector: "#geetest_captcha, .geetest_captcha, .geetest_btn_click" },
  { vendor: "perimeterx", frame: /px-captcha|captcha\.px-cdn/i, selector: "#px-captcha" },
  { vendor: "brave", frame: /brave\.com\/.*captcha/i, selector: "[class*=default-captcha-button], [id*=default-captcha-button]", markup: /default-captcha-button/ },
  { vendor: "datadome", frame: /captcha-delivery\.com\/captcha|\.ddc\.[a-z0-9.-]+\/captcha/i, selector: "[data-dd-captcha-container]", markup: /data-dd-captcha-container/ },
  { vendor: "arkose", shownFrame: /^https:\/\/(?:[a-z0-9-]+\.)*arkoselabs\.com\/|^https:\/\/arkoselabs\.roblox\.com\//i, markup: /<iframe\b[^>]*\bsrc="https:\/\/(?:[a-z0-9-]+\.)*arkoselabs\.com\/|<iframe\b[^>]*\bsrc="https:\/\/arkoselabs\.roblox\.com\/|data-e2e="enforcement-frame"/i },
];
