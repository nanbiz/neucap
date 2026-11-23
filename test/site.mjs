// Pages guarded by stand-ins of the checks the extension answers, for its end-to-end tests, each
// drawn with the markup the vendor's own carries and fed a puzzle the vendor accepted an answer to
// (test/data); each passes only with that answer, and sets window.PASSED.
//
// /top.html: reCAPTCHA. The box and the grid live in frames of another site (localhost against
// 127.0.0.1, so Chrome runs them in a process of their own, as Google's are); GRID picks the grid,
// which passes with the squares Google accepted. A clicked square is replaced by an empty one, as
// Google's dynamic grids do.
// /brave.html?n=<1-9>: Brave Search's slider wall.
// /geetest.html?n=<1-3>: GeeTest's slide behind a form's button.
// /hcaptcha.html: hCaptcha's box and challenge in frames of another site, answered in its
// accessibility (text) mode with three questions.
// /hcaptcha.html?kind=line&n=<1-4>: the same frames with a picture challenge instead, "drag the
// segments to complete the line" from a puzzle hCaptcha served (test/data/
// hcaptcha-line): its canvas laid out as hCaptcha's (twice the drawing units in pixels, the picture at
// 10, 135), its pictures from a host named hcaptcha, no accessibility challenge in its menu; it passes
// with both segments dropped within 8 units of where they fit.
// /turnstile.html: a Cloudflare wall whose form sends itself once Turnstile's box (a frame of
// another site) is ticked.
// /perimeterx.html: PerimeterX's press-and-hold button, let through after five seconds of holding.
// /turnstile.html?refuse=1: the same wall whose box never takes a click, for a solve that fails;
// ?alert=1 opens an alert as the box is ticked, which leaves the page answering nothing; ?leave=1 goes to
// another address by itself a second and a half after loading (with &to=refuse, to the refusing
// wall).
// /unsupported.html: a frame detect.js and the worker take for GeeTest's, with nothing of GeeTest's
// in it, for a check no reader answers.
// /yandex-text.html and /yandex-symbols.html?n=<i>: Yandex SmartCaptcha's puzzle page, fed puzzles
// Yandex served live with their answers read by eye, which are not in the repository: YANDEX_TEXT
// names a list (picture path<TAB>answer; the pictures' folder is the path's own or
// YANDEX_TEXT_DIR) and YANDEX_SYMBOLS a truth file ([{picture, strip, truth: [[x, y], ...]}],
// paths relative to its folder or YANDEX_SYMBOLS_DIR). Text passes with the answer typed;
// symbols with a click within 16 picture pixels of each asked symbol, in the strip's order.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const tests = path.resolve(import.meta.dirname, "data");
const data = path.join(tests, "recaptcha");
const GRIDS = { "bus-3x3": ["buses", [0, 1, 4]], "car-3x3-a": ["cars", [0, 1, 3, 4]], "bicycle-3x3": ["bicycles", [3, 6, 8]] };
const grid = process.env.GRID ?? "bus-3x3";
const [word, accepted] = GRIDS[grid];

// A 100x100 grey PNG for the squares put in place of clicked ones.
function grey() {
  const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(100, 0); ihdr.writeUInt32BE(100, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(100 * (1 + 300), 128); for (let y = 0; y < 100; y++) raw[y * 301] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const top = `<!doctype html><html><body style="font-family:sans-serif">
<h3>Sign up</h3><form><input placeholder="Name"><br><br>
<iframe id="anchor" src="http://localhost:8778/recaptcha/api2/anchor?ar=1&k=6Le&size=normal" style="width:304px;height:78px;border:0"></iframe>
<br><button type="button">Send</button></form>
<div id="challenge" style="position:absolute;left:20px;top:150px;visibility:hidden">
<iframe id="bframe" src="http://localhost:8778/recaptcha/api2/bframe?grid=${grid}" style="width:400px;height:0;border:1px solid #ccc"></iframe></div>
<script>
addEventListener("message", e => {
  if (e.data === "open") { document.getElementById("challenge").style.visibility = "visible"; document.getElementById("bframe").style.height = "580px"; }
  if (e.data === "solved") { document.getElementById("challenge").style.visibility = "hidden"; document.getElementById("bframe").style.height = "0"; document.getElementById("anchor").contentWindow.postMessage("solved", "*"); }
});
</script></body></html>`;

const anchor = `<!doctype html><html><body style="margin:0">
<div style="display:flex;align-items:center;gap:12px;padding:24px 12px">
<span id="recaptcha-anchor" role="checkbox" aria-checked="false" style="display:inline-block;width:24px;height:24px;border:2px solid #555;cursor:pointer"></span><span>I'm not a robot</span></div>
<script>
const box = document.getElementById("recaptcha-anchor");
box.addEventListener("click", e => { window.TRUSTED = e.isTrusted; parent.postMessage("open", "*"); });
addEventListener("message", e => { if (e.data === "solved") { box.setAttribute("aria-checked", "true"); box.style.background = "#4a4"; } });
</script></body></html>`;

const bframe = `<!doctype html><html><body style="margin:0;font-family:sans-serif">
<div class="rc-imageselect-desc-wrapper" style="background:#1a73e8;color:#fff;padding:12px">Select all images with <strong>${word}</strong></div>
<table class="rc-imageselect-table-33" style="border-spacing:4px">${[0, 1, 2].map(r => `<tr>${[0, 1, 2].map(c => {
  const i = r * 3 + c;
  return `<td class="rc-imageselect-tile" data-i="${i}" style="width:126px;height:126px;overflow:hidden;position:relative;padding:0"><img class="rc-image-tile-33" src="/grids/${grid}.png" style="position:absolute;width:378px;height:378px;left:-${c * 126}px;top:-${r * 126}px"></td>`;
}).join("")}</tr>`).join("")}</table>
<div class="rc-imageselect-incorrect-response" style="display:none;color:red">Please try again.</div>
<button id="recaptcha-reload-button" style="margin:8px">reload</button><button id="recaptcha-verify-button" style="margin:8px;float:right">Verify</button>
<script>
const chosen = new Set();
for (const td of document.querySelectorAll("td.rc-imageselect-tile")) td.addEventListener("click", () => {
  const i = Number(td.dataset.i);
  if (chosen.has(i)) return;
  chosen.add(i);
  td.classList.add("rc-imageselect-dynamic-selected");
  setTimeout(() => { td.innerHTML = '<img class="rc-image-tile-11" src="/grey.png" style="width:126px;height:126px">'; td.classList.remove("rc-imageselect-dynamic-selected"); }, 800);
});
document.getElementById("recaptcha-verify-button").addEventListener("click", () => {
  const want = ${JSON.stringify(accepted)};
  const right = want.length === chosen.size && want.every(i => chosen.has(i));
  window.VERDICT = { right, chosen: [...chosen].sort() };
  if (right) parent.postMessage("solved", "*");
  else document.querySelector(".rc-imageselect-incorrect-response").style.display = "block";
});
</script></body></html>`;

const serve = (port, route) => http.createServer((q, a) => {
  const body = route(new URL(q.url, `http://x:${port}`));
  if (!body) { a.writeHead(404); return a.end(); }
  a.writeHead(200, { "content-type": body.type, ...(body.cors ? { "access-control-allow-origin": "*" } : {}) });
  a.end(body.data);
}).listen(port);

// Brave's wall: the picture and the red disc on canvases of their own, drawn a little narrower than
// their pixels; the slider's button moves the disc. Accepted within 4 canvas pixels of the target.
const BRAVE = { 1: 137, 2: 244, 3: 80, 4: 279, 5: 96, 6: 85, 7: 174, 8: 198, 9: 130 };
const brave = n => `<!doctype html><html><head><title>Captcha</title></head><body style="font-family:sans-serif">
<main id="wall"><h3>Confirm you are human</h3>
<div style="position:relative;width:280px;height:140px">
<canvas class="captcha-image-canvas" width="310" height="155" style="position:absolute;left:0;top:0;width:280px"></canvas>
<canvas class="captcha-slider-canvas" width="310" height="155" style="position:absolute;left:0;top:0;width:280px"></canvas></div>
<div style="position:relative;width:280px;height:36px;background:#eee;margin-top:8px">
<button class="captcha-slider-button" style="position:absolute;left:0;top:0;width:40px;height:36px">&gt;</button></div></main>
<script>
const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = src; });
const [picture, piece] = [document.querySelector(".captcha-image-canvas"), document.querySelector(".captcha-slider-canvas")];
const button = document.querySelector(".captcha-slider-button");
const scale = 310 / 280;
let centre = 0, moved = 0, from = null;
Promise.all([load("/data/brave/${n}-picture.png"), load("/data/brave/${n}-piece.png")]).then(([a, b]) => {
  picture.getContext("2d").drawImage(a, 0, 0);
  const c = piece.getContext("2d"); c.drawImage(b, 0, 0);
  const px = c.getImageData(0, 0, 310, 155).data; let sum = 0, count = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0) { sum += (i / 4) % 310; count++; }
  centre = sum / count;
});
button.addEventListener("mousedown", e => { from = e.clientX; });
addEventListener("mousemove", e => { if (from === null) return; moved = Math.max(0, e.clientX - from); piece.style.left = button.style.left = moved + "px"; });
addEventListener("mouseup", () => {
  if (from === null) return;
  from = null;
  const at = centre + moved * scale;
  window.VERDICT = { at, target: ${BRAVE[n]}, right: Math.abs(at - ${BRAVE[n]}) <= 4 };
  if (window.VERDICT.right) setTimeout(() => { window.PASSED = true; document.open(); document.write("<p>Search results</p>"); document.close(); }, 800);
  else setTimeout(() => { moved = 0; piece.style.left = button.style.left = "0px"; }, 500);
});
</script></body></html>`;

// GeeTest: a form whose button opens the slide; the piece moves with the button, scaled as the
// picture is shown. Accepted within 2 picture pixels of the gap GeeTest accepted.
const geetest = n => {
  const { gap, top: pieceTop } = JSON.parse(fs.readFileSync(path.join(tests, `geetest/${n}.json`), "utf8"));
  return `<!doctype html><html><head><script src="/static/gt4.js"></script></head><body style="font-family:sans-serif">
<h1>The page did not load because of your IP</h1>
<form><div id="geetest_captcha" class="geetest_captcha" style="display:inline-block"><input type="hidden" name="captcha-response"></div>
<button type="button" id="open">Pass the check</button></form>
<div class="geetest_box_wrap" style="display:none"><div class="geetest_box" style="width:340px;padding:10px;border:1px solid #ccc">
<div class="geetest_slide"><div class="geetest_bg" style="position:relative;width:340px;height:${(200 * 340) / 300}px;background-image:url('/data/geetest/${n}-picture.png');background-size:100% 100%">
<div class="geetest_slice" style="position:absolute;left:0;top:${(pieceTop * 340) / 300}px;width:${(80 * 340) / 300}px;height:${(80 * 340) / 300}px">
<div class="geetest_slice_bg" style="width:100%;height:100%;background-image:url('/data/geetest/${n}-piece.png');background-size:100% 100%"></div></div></div>
<div style="position:relative;height:40px;background:#eee;margin-top:8px"><div class="geetest_btn" style="position:absolute;left:0;top:0;width:50px;height:40px;background:#39f"></div></div></div>
<div class="geetest_result_tips"></div></div></div>
<script>
const scale = 340 / 300;
document.getElementById("open").addEventListener("click", () => { document.querySelector(".geetest_box_wrap").style.display = "block"; });
const button = document.querySelector(".geetest_btn"), slice = document.querySelector(".geetest_slice");
let from = null, moved = 0;
button.addEventListener("mousedown", e => { from = e.clientX; });
addEventListener("mousemove", e => { if (from === null) return; moved = Math.max(0, e.clientX - from); slice.style.left = button.style.left = moved + "px"; });
addEventListener("mouseup", () => {
  if (from === null) return;
  from = null;
  const at = moved / scale;
  window.VERDICT = { at, gap: ${gap}, right: Math.abs(at - ${gap}) < 2 };
  const box = document.querySelector(".geetest_captcha");
  if (window.VERDICT.right) {
    box.classList.add("geetest_success");
    setTimeout(() => { window.PASSED = true; document.open(); document.write("<p>The page</p>"); document.close(); }, 800);
  } else box.classList.add("geetest_fail");
});
</script></body></html>`;
};

// hCaptcha: the frames' addresses carry hcaptcha.com/captcha in their path, as the vendor's carry it
// in host and path, and #frame=<kind>& as theirs do.
const HCAPTCHA = "http://localhost:8778/hcaptcha.com/captcha/v1/x/static/hcaptcha.html";
const hcaptchaTop = (kind, n) => `<!doctype html><html><body style="font-family:sans-serif">
<h3>Sign in</h3><form><input placeholder="Email"><br><br>
<iframe id="hbox" src="${HCAPTCHA}#frame=checkbox&id=1" style="width:303px;height:78px;border:0"></iframe>
<br><button type="button">Send</button></form>
<iframe id="hchallenge" src="${HCAPTCHA}#frame=challenge&id=1${kind ? `&kind=${kind}&n=${n}` : ""}" style="position:absolute;left:20px;top:140px;width:${kind ? 540 : 400}px;height:0;border:1px solid #ccc"></iframe>
<script>
addEventListener("message", e => {
  if (e.data === "open") document.getElementById("hchallenge").style.height = "${kind ? 640 : 560}px";
  if (e.data === "solved") { document.getElementById("hchallenge").style.height = "0"; document.getElementById("hbox").contentWindow.postMessage("solved", "*"); window.PASSED = true; }
});
</script></body></html>`;
const QUESTIONS = [["A jar has 36 coins. You remove 21 coins", "15"], ["Is herring a fish?", "yes"], ["How many hours in a day?", "24"]];
const hcaptchaFrame = `<!doctype html><html><body style="margin:0;font-family:sans-serif">
<div id="checkbox-view" style="display:none;padding:20px 12px"><div id="checkbox" role="checkbox" aria-checked="false" style="display:inline-block;width:28px;height:28px;border:2px solid #555"></div> I am human</div>
<div id="challenge-view" style="display:none;padding:10px">
<div class="challenge-pictures"><div class="prompt-text">Please click each image containing a lorry</div><div style="height:300px;background:#ddd"></div></div>
<div class="challenge-text" style="display:none"><div id="prompt-question">Answer the following question with a single word, number, or phrase.</div>
<div id="prompt-text"></div><input class="input-field" style="width:200px"><button class="button-submit">Next</button><div id="wrong" style="display:none;color:red">Please try again</div></div>
<div class="challenge-canvas" style="display:none"><div class="prompt-text">Drag the segments to complete the line</div>
<canvas id="board" width="1000" height="960" style="width:500px;height:480px;display:block"></canvas><button class="button-submit" id="picture-submit">Check</button></div>
<div style="margin-top:12px"><button id="display-language">EN</button> <button id="menu-info" aria-label="Info">i</button>
<div id="menu" style="display:none;border:1px solid #999"><div role="menuitem" aria-label="Accessibility Challenge" style="padding:6px">Accessibility Challenge</div><div role="menuitem" aria-label="Report Image" style="padding:6px">Report</div></div></div></div>
<script>
const kind = location.hash.match(/frame=([a-z]+)/)[1];
const QUESTIONS = ${JSON.stringify(QUESTIONS)};
if (kind === "checkbox") {
  document.getElementById("checkbox-view").style.display = "block";
  const box = document.getElementById("checkbox");
  box.addEventListener("click", e => { window.TRUSTED = e.isTrusted; parent.postMessage("open", "*"); });
  addEventListener("message", e => { if (e.data === "solved") box.setAttribute("aria-checked", "true"); });
} else if (/kind=line/.test(location.hash)) {
  // A picture challenge: the canvas in drawing units (two pixels each), the picture at 10, 135, the
  // two segments above it; a segment dragged follows the mouse and lands where it is let go.
  document.getElementById("challenge-view").style.display = "block";
  document.querySelector(".challenge-pictures").remove();
  document.querySelector(".challenge-text").remove();
  document.querySelector(".challenge-canvas").style.display = "block";
  document.querySelector("[aria-label='Accessibility Challenge']").remove();
  document.getElementById("menu-info").addEventListener("click", () => { document.getElementById("menu").style.display = "block"; });
  addEventListener("keydown", e => { if (e.key === "Escape") document.getElementById("menu").style.display = "none"; });
  const n = location.hash.match(/n=([0-9]+)/)[1];
  const base = "http://hcaptcha.localhost:8778/hcd/line/" + n;
  const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error(src + " did not load")); i.src = src; });
  const board = document.getElementById("board"), ctx = board.getContext("2d");
  ctx.scale(2, 2);
  Promise.all([load(base + "-picture.jpeg"), load(base + "-piece0.png"), load(base + "-piece1.png"), fetch(base + ".json").then(r => r.json())]).then(([picture, p0, p1, meta]) => {
    const pieces = [{ img: p0, x: 60, y: 20 }, { img: p1, x: 300, y: 20 }];
    pieces.forEach((p, i) => { p.want = [10 + meta.at[i][0] + p.img.width / 2, 135 + meta.at[i][1] + p.img.height / 2]; });
    const draw = () => {
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 500, 480);
      ctx.drawImage(picture, 10, 135);
      for (const p of pieces) ctx.drawImage(p.img, p.x, p.y);
    };
    draw();
    let held = null;
    const at = e => { const r = board.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    board.addEventListener("mousedown", e => {
      const [x, y] = at(e);
      held = pieces.find(p => x >= p.x && x <= p.x + p.img.width && y >= p.y && y <= p.y + p.img.height) ?? null;
      if (held) held.grab = [x - held.x, y - held.y, e.isTrusted];
    });
    addEventListener("mousemove", e => { if (!held) return; const [x, y] = at(e); held.x = x - held.grab[0]; held.y = y - held.grab[1]; draw(); });
    addEventListener("mouseup", e => {
      if (!held) return;
      const [x, y] = at(e);
      held.x = x - held.grab[0]; held.y = y - held.grab[1];
      held.dropped = [held.x + held.img.width / 2, held.y + held.img.height / 2, held.grab[2] && e.isTrusted];
      held = null; draw();
    });
    document.getElementById("picture-submit").addEventListener("click", () => {
      const near = p => p.dropped && p.dropped[2] && Math.abs(p.dropped[0] - p.want[0]) <= 8 && Math.abs(p.dropped[1] - p.want[1]) <= 8;
      const right = pieces.every(near);
      window.VERDICT = { right, dropped: pieces.map(p => p.dropped), want: pieces.map(p => p.want) };
      if (right) parent.postMessage("solved", "*");
    });
  }).catch(e => { document.querySelector(".prompt-text").innerText = String(e); window.VERDICT = { right: false, error: String(e) }; });
} else {
  document.getElementById("challenge-view").style.display = "block";
  let asked = 0;
  const ask = () => { document.getElementById("prompt-text").innerText = QUESTIONS[asked][0]; document.querySelector(".input-field").value = ""; };
  document.getElementById("menu-info").addEventListener("click", () => { document.getElementById("menu").style.display = "block"; });
  document.querySelector("[aria-label='Accessibility Challenge']").addEventListener("click", () => {
    document.getElementById("menu").style.display = "none";
    document.querySelector(".challenge-pictures").style.display = "none";
    document.querySelector(".challenge-text").style.display = "block";
    ask();
  });
  document.querySelector(".button-submit").addEventListener("click", () => {
    const typed = document.querySelector(".input-field").value.trim().toLowerCase();
    window.ANSWERS = [...(window.ANSWERS ?? []), typed];
    if (typed !== QUESTIONS[asked][1]) { document.getElementById("wrong").style.display = "block"; asked = 0; setTimeout(ask, 300); return; }
    asked++;
    if (asked === QUESTIONS.length) { window.VERDICT = { right: true, answers: window.ANSWERS }; parent.postMessage("solved", "*"); }
    else setTimeout(ask, 300);
  });
}
</script></body></html>`;

// Turnstile: the box frame's address carries challenges.cloudflare.com/turnstile in its path, as
// Cloudflare's carries it in host and path; a click in its box writes the token into the form.
const turnstileTop = `<!doctype html><html><head><title>Just a moment...</title></head><body style="font-family:sans-serif">
<h2>Verify you are human by completing the action below.</h2>
<form action="/turnstile-passed" method="get"><div class="cf-turnstile"><iframe src="http://localhost:8778/challenges.cloudflare.com/turnstile/if/ov2/av0/rcv/x/normal" style="width:300px;height:65px;border:0"></iframe></div>
<input type="hidden" name="cf-turnstile-response" value=""><button type="submit">Continue</button></form>
<script>window._cf_chl_opt = { cType: "managed" };
addEventListener("message", e => { if (String(e.data).startsWith("token:")) document.querySelector("input[name=cf-turnstile-response]").value = e.data.slice(6); });
</script></body></html>`;
const turnstileFrame = `<!doctype html><html><body style="margin:0;font-family:sans-serif;background:#fafafa">
<label style="display:flex;align-items:center;gap:10px;height:65px;padding-left:18px"><span id="box" style="display:inline-block;width:24px;height:24px;border:2px solid #666"></span>Verify you are human</label>
<script>
document.querySelector("label").addEventListener("click", e => {
  window.CLICK = { trusted: e.isTrusted, x: e.clientX, y: e.clientY };
  if (!e.isTrusted || e.clientX < 10 || e.clientX > 60) return;
  document.getElementById("box").style.background = "#2a2";
  setTimeout(() => parent.postMessage("token:0.fake-token", "*"), 700);
});
</script></body></html>`;

// PerimeterX: the button lets go once held for five seconds with the mouse over it.
const perimeterx = `<!doctype html><html><head><title>Access to this page has been denied</title></head><body style="font-family:sans-serif">
<h1>Please verify you are a human</h1><p>Press &amp; Hold</p>
<div id="px-captcha" style="width:260px;height:56px;border:2px solid #333;border-radius:28px;position:relative;overflow:hidden"><div id="fill" style="position:absolute;inset:0;width:0;background:#9cf"></div></div>
<script>
const button = document.getElementById("px-captcha"), fill = document.getElementById("fill");
let since = null, timer = null;
button.addEventListener("mousedown", e => {
  if (!e.isTrusted) return;
  since = Date.now();
  timer = setInterval(() => {
    const held = Date.now() - since;
    fill.style.width = Math.min(100, held / 50) + "%";
    if (held >= 5000) { clearInterval(timer); window.PASSED = true; window.VERDICT = { right: true, held }; document.open(); document.write("<p>The shop</p>"); document.close(); }
  }, 100);
});
addEventListener("mouseup", () => { clearInterval(timer); if (!window.PASSED) { since = null; fill.style.width = "0"; } });
</script></body></html>`;

// Yandex: the text puzzle's picture comes from an address with "captchaimage" in it, as Yandex's
// does; Refresh shows the next puzzle of the list.
const textPuzzles = process.env.YANDEX_TEXT
  ? fs.readFileSync(process.env.YANDEX_TEXT, "utf8").trim().split("\n").map(l => l.split("\t"))
      .map(([file, answer]) => [path.join(process.env.YANDEX_TEXT_DIR ?? path.dirname(file), path.basename(file)), answer])
  : [];
const symbolPuzzles = process.env.YANDEX_SYMBOLS ? JSON.parse(fs.readFileSync(process.env.YANDEX_SYMBOLS, "utf8")) : [];
const symbolFile = f => path.join(process.env.YANDEX_SYMBOLS_DIR ?? path.dirname(process.env.YANDEX_SYMBOLS), f);
const yandexText = `<!doctype html><html><body style="font-family:sans-serif"><div class="AdvancedCaptcha AdvancedCaptcha_kaleidoscope">
<div class="AdvancedCaptcha-View"><img src="/captchaimage?i=0" style="width:300px"></div>
<form id="f"><input name="rep" autocomplete="off" style="width:240px"></form>
<button data-testid="refresh">Refresh</button> <button data-testid="submit">Submit</button></div>
<script>
const ANSWERS = ${JSON.stringify(textPuzzles.map(p => p[1]))};
let i = 0;
const img = document.querySelector(".AdvancedCaptcha-View img");
document.querySelector("#f").addEventListener("submit", e => e.preventDefault());
document.querySelector("[data-testid=refresh]").addEventListener("click", () => { i = (i + 1) % ANSWERS.length; img.src = "/captchaimage?i=" + i; document.querySelector("[name=rep]").value = ""; });
document.querySelector("[data-testid=submit]").addEventListener("click", () => {
  const typed = document.querySelector("[name=rep]").value.trim();
  window.VERDICT = { right: typed === ANSWERS[i], typed, answer: ANSWERS[i], picture: i };
  if (window.VERDICT.right) { window.PASSED = true; document.open(); document.write("<p>Search results</p>"); document.close(); }
  else { i = (i + 1) % ANSWERS.length; img.src = "/captchaimage?i=" + i; document.querySelector("[name=rep]").value = ""; }
});
</script></body></html>`;
const yandexSymbols = n => {
  const p = symbolPuzzles[n];
  return `<!doctype html><html><body style="font-family:sans-serif"><div class="AdvancedCaptcha AdvancedCaptcha_silhouette">
<div class="AdvancedCaptcha-ImageWrapper" style="position:relative;display:inline-block"><img src="/ysym/${n}/picture" style="width:300px"></div>
<div class="TaskImage"><img class="TaskImage-Img" src="/ysym/${n}/strip"></div>
<button data-testid="refresh">Refresh</button> <button data-testid="submit">Submit</button></div>
<script>
const TRUTH = ${JSON.stringify(p?.truth ?? [])};
const img = document.querySelector(".AdvancedCaptcha-ImageWrapper img");
const clicks = [];
img.addEventListener("click", e => {
  const r = img.getBoundingClientRect(), scale = img.naturalWidth / r.width;
  clicks.push([(e.clientX - r.left) * scale, (e.clientY - r.top) * scale, e.isTrusted]);
});
document.querySelector("[data-testid=submit]").addEventListener("click", () => {
  const near = (c, t) => Math.hypot(c[0] - t[0], c[1] - t[1]) <= 16;
  const right = clicks.length === TRUTH.length && TRUTH.every((t, k) => near(clicks[k], t) && clicks[k][2]);
  window.VERDICT = { right, clicks, truth: TRUTH };
  if (right) { window.PASSED = true; document.open(); document.write("<p>Search results</p>"); document.close(); }
});
</script></body></html>`;
};

serve(8777, u => {
  if (u.pathname === "/yandex-text.html") return { type: "text/html", data: yandexText };
  if (u.pathname === "/captchaimage") return { type: "image/png", data: fs.readFileSync(textPuzzles[Number(u.searchParams.get("i"))][0]) };
  if (u.pathname === "/yandex-symbols.html") return { type: "text/html", data: yandexSymbols(Number(u.searchParams.get("n") ?? 0)) };
  const y = u.pathname.match(/^\/ysym\/(\d+)\/(picture|strip)$/);
  if (y) return { type: "image/png", data: fs.readFileSync(symbolFile(symbolPuzzles[Number(y[1])][y[2]])) };
  if (u.pathname === "/turnstile.html") {
    let page = turnstileTop;
    if (u.searchParams.get("refuse")) page = page.replace("/turnstile/if/", "/turnstile/refuse/if/");
    if (u.searchParams.get("alert")) page = page.replace('addEventListener("message", e => { if (String(e.data).startsWith("token:")) ', 'addEventListener("message", e => { if (String(e.data).startsWith("token:")) alert("verified"); if (String(e.data).startsWith("token:")) ');
    if (u.searchParams.get("leave")) page = page.replace("<script>", `<script>setTimeout(() => { location.href = ${JSON.stringify(u.searchParams.get("to") === "refuse" ? "/turnstile.html?refuse=1&from=leave" : "/turnstile-passed")}; }, 1500);`);
    return { type: "text/html", data: page };
  }
  if (u.pathname === "/unsupported.html") return { type: "text/html", data: `<!doctype html><html><body><h3>Sign in</h3><iframe src="http://localhost:8778/static.geetest.com/captcha/unknown" style="width:300px;height:150px;border:1px solid #ccc"></iframe></body></html>` };
  if (u.pathname === "/turnstile-passed") return { type: "text/html", data: `<p>The forum</p><script>window.PASSED = ${!!u.searchParams.get("cf-turnstile-response")}; window.VERDICT = { right: true, token: ${JSON.stringify(u.searchParams.get("cf-turnstile-response"))} };</script>` };
  if (u.pathname === "/perimeterx.html") return { type: "text/html", data: perimeterx };
  if (u.pathname === "/hcaptcha.html") return { type: "text/html", data: hcaptchaTop(u.searchParams.get("kind"), u.searchParams.get("n") ?? "1") };
  if (u.pathname === "/top.html") return { type: "text/html", data: top };
  const n = u.searchParams.get("n") ?? "1";
  if (u.pathname === "/brave.html") return { type: "text/html", data: brave(n) };
  if (u.pathname === "/geetest.html") return { type: "text/html", data: geetest(n) };
  if (u.pathname === "/static/gt4.js") return { type: "text/javascript", data: "" };
  const d = u.pathname.match(/^\/data\/(brave|geetest)\/([\w-]+\.png)$/);
  if (d) return { type: "image/png", data: fs.readFileSync(path.join(tests, d[1], d[2])) };
  return null;
});
serve(8778, u => {
  if (u.pathname === "/recaptcha/api2/anchor") return { type: "text/html", data: anchor };
  if (u.pathname === "/recaptcha/api2/bframe") return { type: "text/html", data: bframe };
  if (u.pathname === "/grey.png") return { type: "image/png", data: grey() };
  if (u.pathname === "/hcaptcha.com/captcha/v1/x/static/hcaptcha.html") return { type: "text/html", data: hcaptchaFrame };
  const h = u.pathname.match(/^\/hcd\/(line)\/(\d+(?:-picture\.jpeg|-piece[01]\.png|\.json))$/);
  if (h) return { type: h[2].endsWith(".json") ? "application/json" : h[2].endsWith(".png") ? "image/png" : "image/jpeg", data: fs.readFileSync(path.join(tests, `hcaptcha-${h[1]}`, h[2])), cors: true };
  if (u.pathname.startsWith("/challenges.cloudflare.com/turnstile/refuse/")) return { type: "text/html", data: turnstileFrame.replace("if (!e.isTrusted", "if (true || !e.isTrusted") };
  if (u.pathname.startsWith("/challenges.cloudflare.com/turnstile/")) return { type: "text/html", data: turnstileFrame };
  if (u.pathname.startsWith("/static.geetest.com/")) return { type: "text/html", data: "<!doctype html><body style=\"margin:0;background:#2a7\"><p>Select all images with lighthouses</p></body>" };
  const g = u.pathname.match(/^\/grids\/([\w-]+)\.png$/);
  if (g && GRIDS[g[1]]) return { type: "image/png", data: fs.readFileSync(path.join(data, `${g[1]}.png`)) };
  return null;
});
console.log(`serving ${grid}: http://127.0.0.1:8777/top.html`);
