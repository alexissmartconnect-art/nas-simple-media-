#!/bin/bash
# Runs Gradle and, on failure, emits the tail as a GitHub annotation.
# Job logs are stored off api.github.com and are not always readable here.
set -u
cd "$(dirname "$0")/.."
log="${RUNNER_TEMP:-/tmp}/gradle-ci.log"
set +e
./gradlew --no-daemon --stacktrace "$@" >"$log" 2>&1
code=$?
set -e
tail -n 80 "$log"
if [ "$code" -ne 0 ]; then
  python3 - << 'PY'
import os
from pathlib import Path
log = Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "gradle-ci.log"
text = log.read_text(encoding="utf-8", errors="replace") if log.is_file() else ""
lines = [ln for ln in text.splitlines() if ln.strip()]
interesting = [
    ln for ln in lines
    if any(k in ln for k in ("FAILURE", "error:", "Error", "What went wrong", "FAILED", "Exception", "Could not"))
]
tail = (interesting[-12:] or lines[-12:])
msg = " | ".join(tail)[:3000]
for ch, esc in (("\r", ""), ("\n", " "), ("%", "%25")):
    msg = msg.replace(ch, esc)
print(f"::error::Gradle a échoué. {msg}")
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    with open(summary, "a", encoding="utf-8") as fh:
        fh.write("### Gradle\n\n```\n")
        fh.write("\n".join(lines[-60:]))
        fh.write("\n```\n")
PY
  exit "$code"
fi
