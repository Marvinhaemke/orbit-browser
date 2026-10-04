#!/usr/bin/env bash
# Run by MozillaBuild's own Bash; do not substitute Git Bash or Cygwin.
set -euo pipefail
export MOZILLABUILD='C:\mozilla-build'
export PATH="/c/mozilla-build/bin:/c/mozilla-build/python3:/c/mozilla-build/msys2/usr/bin:$PATH"
export MACH_HIDE_DEV_DRIVE_SUGGESTION=1
export MACH_TELEMETRY_NO_SUBMIT=1

ORBIT_REPO_PATH="$1"
ORBIT_SOURCE_PATH="$2"
cd "$ORBIT_REPO_PATH"
/c/mozilla-build/python3/python.exe scripts/prepare_source.py --source "$ORBIT_SOURCE_PATH"
/c/mozilla-build/python3/python.exe scripts/build.py --source "$ORBIT_SOURCE_PATH"
