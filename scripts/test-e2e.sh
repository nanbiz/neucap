#!/bin/sh
# Runs the end-to-end test against an assembled extension: serves the stand-in reCAPTCHA page
# (test/site.mjs), loads the extension into the browser, and passes once the extension has answered
# the check by itself. CHROME_PATH picks the browser, EXTENSION the folder (dist/neucap by default),
# WAIT the seconds the check may take.
set -eu
cd "$(dirname "$0")/.."
: "${CHROME_PATH:?CHROME_PATH names the browser}"
export EXTENSION=${EXTENSION:-$PWD/dist/neucap}
node test/site.mjs &
site=$!
trap 'kill $site 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -fsS -o /dev/null http://127.0.0.1:8777/top.html && break; sleep 0.2; done
node test/run.mjs "$CHROME_PATH" http://127.0.0.1:8777/top.html "${WAIT:-240}"
