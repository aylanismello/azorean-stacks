#!/usr/bin/env bash
# Capture pipeline snapshot with timestamp
STATS=$(curl -s https://azorean-stacks.vercel.app/api/stats/engine)
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DL=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin)['pipeline']['downloaded'])" 2>/dev/null)
PENDING_DL=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin)['pipeline']['pending_download'])" 2>/dev/null)
PENDING_EN=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin)['pipeline']['pending_enrichment'])" 2>/dev/null)
TOTAL=$(echo "$STATS" | python3 -c "import sys,json; print(json.load(sys.stdin)['pipeline']['total'])" 2>/dev/null)
YTDLP=$(ps aux | grep yt-dlp | grep -v grep | wc -l | tr -d ' ')
echo "${TS},${TOTAL},${DL},${PENDING_DL},${PENDING_EN},${YTDLP}" >> ~/.openclaw/data/pipeline-snapshots.csv
echo "${TS} | total:${TOTAL} dl:${DL} pending_dl:${PENDING_DL} pending_en:${PENDING_EN} yt-dlp:${YTDLP}"
