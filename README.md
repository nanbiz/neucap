# NeuCap

NeuCap is a Chromium extension (Manifest V3) that answers the captchas a page puts in front of you. It notices a check from a vendor it knows (reCAPTCHA, hCaptcha, Cloudflare Turnstile, GeeTest, Yandex SmartCaptcha, Arkose, PerimeterX, Brave Search's slider), solves it in your browser with image models that run locally, and clicks, drags or types the answer as real input. For each site it has a mode: Auto answers by itself, Ask waits for the Solve now button, Off never touches the site. There is a global pause, a switch per vendor and per check, and a history of every solve.

## Install

1. Download `neucap-<version>.zip` from the [releases](../../releases) and unzip it into a folder you keep.
2. Open `chrome://extensions` (or your browser's equivalent), turn on Developer mode, choose Load unpacked and pick the folder.

The zip is about 1 GB, mostly neural network files. While a solve runs the browser shows its bar saying NeuCap is debugging the tab; it goes away when the solve ends.

## Open and compiled

Everything in this repository except `wasm/` is open: the service worker (`sw.js`), the page detector (`detect.js`, `patterns.js`), the popup and settings pages (`ui/`), the manifest, the icons, the test page and the build scripts. That is the part that holds the permissions, so you can read what it does with the debugger, the network and your data.

The puzzle solvers, the code that reads a puzzle's pictures and decides the answer, ship only as compiled WebAssembly (`wasm/`). They stay closed so the sites behind the puzzles cannot read how they work and adapt to them.

## Why the compiled part is safe to trust

WebAssembly runs in a sandbox. A module has no network access, no access to the page and no access to the browser's APIs of its own. It can call only the functions its host hands it. Here the host is `sw.js`, which is open: it passes puzzle images in and receives clicks, drags and keystrokes out, and that is the whole interface. So reading `sw.js` shows everything the closed part can reach: it cannot send anything anywhere and cannot read your pages or data, because the open code never gives it a way to.

Nothing leaves your browser. The service worker makes no network request of its own; the only files it fetches are its own, from the extension folder. Earlier builds of the private version could report puzzles no solver answered; this build has no such code.

## Verify a download

Each release zip carries a GitHub build attestation that ties it to the commit and workflow run that built it:

```sh
gh attestation verify neucap-<version>.zip --repo nanbiz/neucap
```

`wasm/SHA256SUMS` lists the hashes of the compiled files, `wasm/BUILT_FROM` names the build they come from, and `models.SHA256SUMS` lists the hashes of the models, which the build checks before it packs them. onnxruntime-web comes from npm at the version and integrity hash `pnpm-lock.yaml` pins.

## Permissions

| Permission | Why |
|---|---|
| `debugger` | Attached to a tab only while a solve runs. It sends the clicks, drags and keys as real input and reaches frames of other sites (the captcha's own frame). Detached when the check is gone, on Stop, or when the tab closes. |
| host access to all sites | A captcha can appear on any site, so the page detector runs everywhere. It reads the page's markup for the vendors' check elements only, and the worker reads the check's frame. |
| `scripting` | Reads the page's markup and the check's frame. |
| `tabs` | Finds the tab a check is on and its address, for the per-site mode and the history. |
| `storage`, `unlimitedStorage` | Settings, each tab's state and the history of your last 1000 solves (site, vendor, outcome, timings), kept in the browser. The model files are large. |
| `alarms` | Checks about once a minute whether a new build of the extension is on disk, and ends a pause on time. |
| `notifications` | Tells you when a solve fails. |

## Models

The neural networks are not in git. They are assets of a release in this repository (the one named in `models.release`), and the build downloads them and checks each against `models.SHA256SUMS`. Their licenses are in `NOTICE`:

| File | What it is | License |
|---|---|---|
| `clip-vit-b32-vision.onnx` | OpenAI CLIP ViT-B/32 image encoder | MIT |
| `yolox_s.onnx` | YOLOX-s | Apache 2.0 |
| `hcaptcha_semantic_encoder.onnx` | Google SigLIP 2 ViT-B/32 image encoder | Apache 2.0 |
| `hcaptcha_identical.onnx`, `yandex_match_icon.onnx`, `yandex_match_crop.onnx`, `arkose_yaw.onnx` | ResNet-18 from torchvision's ImageNet weights (BSD 3-Clause), trained further | all rights reserved (trained weights) |
| `yandex_centres.onnx`, `yandex_symbols.onnx`, `yandex_text_enc.onnx`, `yandex_text_step.onnx`, `hcaptcha_objects.onnx` | trained by the authors | all rights reserved |

The runtime, onnxruntime-web, is MIT.

## Build and test

```sh
sh scripts/assemble.sh dist/neucap   # needs node, pnpm and gh
node scripts/package.js              # dist/neucap-<version>.zip
CHROME_PATH=/path/to/chromium sh scripts/test-e2e.sh
```

`test/site.mjs` serves a page guarded by a stand-in reCAPTCHA built from a puzzle Google accepted an answer to, and `test/run.mjs` loads the assembled extension into a browser and passes once the extension has solved it by itself. CI runs it on every push in Chrome for Testing and Chromium, replaces the `test-build` pre-release on each push to `main`, and cuts a release from every `v*` tag.

## License

The open files are MIT (`LICENSE`). `wasm/` and the trained models are not (`NOTICE`).
