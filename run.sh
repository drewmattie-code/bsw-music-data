#!/bin/sh
# Daily music refresh — launchd entry point (com.charlesandroe.bsw-music-daily, 12:00 ET).
# Runs on the Mac Studio against the local gemma-4 server on :8098.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")" || exit 1
git pull --rebase --quiet 2>>run.log || true
PUSH=1 node music-refresh.mjs >>run.log 2>&1
# keep the log bounded
tail -n 4000 run.log > run.log.tmp && mv run.log.tmp run.log
