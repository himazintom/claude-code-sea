#!/bin/sh
# sea sound player for macOS / Linux.
# Plays the pre-rendered wave loop (sound/sea-loop.wav, 480 s, mono, 11025 Hz) with the OS's own audio command.
# The loop is the same wave sound the Windows player synthesizes, rendered once from the same wave schedule and tide.
# To line the sound up with the picture, the loop is rotated so that it starts at the phase the sea has reached.
#
# usage: sea-sound.sh <state dir>
# It follows <state dir>/control.json (on/off, volume, sync) and quits when it is switched off,
# when every session has been silent for about a minute, or when the loop file is missing.
#
# Audio command, first found: afplay (macOS), paplay, ffplay, play (sox), aplay.
# Override with SEA_PLAYER (e.g. SEA_PLAYER="mpv --no-video --really-quiet"); it is given the wav file as its last argument.

STATE="$1"
[ -n "$STATE" ] || { echo "usage: $0 <state dir>" >&2; exit 2; }
DIR=$(cd "$(dirname "$0")" && pwd)
LOOP="$DIR/sea-loop.wav"
CTL="$STATE/control.json"
SESS="$STATE/sessions"
ALIVE="$STATE/player.alive"
LOG="$STATE/player.log"
LOCK="$STATE/player.lock"
CACHE="$STATE/cache"
FLAG="$CACHE/playing.$$"
CHILD="$CACHE/child.$$"
ROT="$CACHE/rotated.$$.wav"
mkdir -p "$SESS" "$CACHE" 2>/dev/null

log() { printf '%s [%s] %s\n' "$(date +%H:%M:%S)" "$$" "$1" >> "$LOG" 2>/dev/null; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time()*1000' 2>/dev/null || echo $(( $(date +%s) * 1000 )); }

[ -f "$LOOP" ] || { log "exit: $LOOP is missing"; exit 3; }

# one player per machine: a lock directory holding our pid (a dead pid means a stale lock)
if ! mkdir "$LOCK" 2>/dev/null; then
  old=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then exit 0; fi
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || exit 0
fi
echo $$ > "$LOCK/pid"

# which audio command
PLAYER=""
if [ -z "$SEA_PLAYER" ]; then
  for p in afplay paplay ffplay play aplay; do
    if command -v "$p" >/dev/null 2>&1; then PLAYER="$p"; break; fi
  done
  if [ -z "$PLAYER" ]; then log "exit: no audio command found (afplay / paplay / ffplay / play / aplay)"; rm -rf "$LOCK"; exit 4; fi
fi

LOOP_PID=""
stop_play() {
  rm -f "$FLAG"
  if [ -f "$CHILD" ]; then kill "$(cat "$CHILD")" 2>/dev/null; rm -f "$CHILD"; fi
  if [ -n "$LOOP_PID" ]; then kill "$LOOP_PID" 2>/dev/null; wait "$LOOP_PID" 2>/dev/null; LOOP_PID=""; fi
}
cleanup() { stop_play; rm -f "$ROT" "$CHILD" "$FLAG"; rm -rf "$LOCK"; }
trap 'cleanup; exit 0' INT TERM HUP
trap cleanup EXIT

# one pass of the loop with the chosen audio command (volume: 0-100, relative to the loop's own peak of 0.9).
# Always run in a background subshell, so exec makes the audio command itself the process we can stop.
play_once() {
  vol="$2"
  if [ -n "$SEA_PLAYER" ]; then exec $SEA_PLAYER "$1"; fi
  linear=$(awk "BEGIN { v = $vol / 90; if (v > 1) v = 1; printf \"%.3f\", v }")
  case "$PLAYER" in
    afplay) exec afplay -v "$linear" "$1" ;;
    paplay) exec paplay --volume="$(( vol * 65536 / 90 > 65536 ? 65536 : vol * 65536 / 90 ))" "$1" ;;
    ffplay) exec ffplay -nodisp -autoexit -loglevel quiet -volume "$vol" "$1" ;;
    play)   exec play -q -v "$linear" "$1" ;;
    aplay)  exec aplay -q "$1" ;;
  esac
}

# rotate the loop so that sample 0 is the sound at the sea's current phase, plus 3 s of lead time. echoes the planned start (ms)
build_rotated() {
  sync="$1"
  planned=$(( $(now_ms) + 3000 ))
  size=$(wc -c < "$LOOP" | tr -d ' ')
  datalen=$(( size - 44 ))
  total_ms=$(( datalen * 1000 / 22050 ))                 # 11025 Hz mono 16-bit = 22050 bytes per second
  phase=$(( (planned - sync) % total_ms ))
  [ "$phase" -lt 0 ] && phase=$(( phase + total_ms ))
  off=$(( phase * 22050 / 1000 ))
  off=$(( off - off % 2 ))                               # stay on a sample boundary
  { head -c 44 "$LOOP"; tail -c +$(( 45 + off )) "$LOOP"; head -c $(( 44 + off )) "$LOOP" | tail -c +45; } > "$ROT"
  log "rotated: phase ${phase} ms, offset ${off} bytes"
  echo "$planned"
}

start_play() {
  vol="$1"
  : > "$FLAG"
  (
    while [ -f "$FLAG" ]; do
      play_once "$ROT" "$vol" &
      echo $! > "$CHILD"
      wait $!
      if [ -f "$FLAG" ]; then sleep 0.2 2>/dev/null || sleep 1; fi    # the loop restarts from its own beginning; a failing command must not spin
    done
  ) &
  LOOP_PID=$!
}

# read "name":value from control.json (the mod writes it with JSON.stringify, so it is one line of plain JSON)
field() { sed -n "s/.*\"$1\":\\(-\\{0,1\\}[0-9a-z.]*\\).*/\\1/p" "$CTL" 2>/dev/null | head -n 1; }

log "start (${PLAYER:-$SEA_PLAYER})"
sig=""; idle=0; last_on="true"
while :; do
  now_ms > "$ALIVE"
  on=$(field on)
  [ -n "$on" ] && last_on="$on"                          # unreadable: keep the last value
  if [ "$last_on" = "false" ]; then log "exit: turned off"; break; fi

  if [ -n "$(find "$SESS" -type f -mmin -1 2>/dev/null | head -n 1)" ]; then idle=0; else idle=$(( idle + 1 )); fi
  if [ "$idle" -ge 3 ]; then log "exit: no live session"; break; fi
  if [ "$idle" -gt 0 ]; then sleep 1; continue; fi

  vol=$(field volume); sync=$(field syncMs)
  [ -n "$vol" ] || vol="${last_vol:-30}"; [ -n "$sync" ] || sync="${last_sync:-120}"
  last_vol="$vol"; last_sync="$sync"
  if [ "$vol|$sync" != "$sig" ]; then
    stop_play
    planned=$(build_rotated "$sync")
    wait_ms=$(( planned - $(now_ms) ))
    [ "$wait_ms" -gt 0 ] && sleep "$(awk "BEGIN { printf \"%.3f\", $wait_ms / 1000 }")"
    start_play "$vol"
    sig="$vol|$sync"
    log "playing (volume $vol, sync $sync ms)"
  elif [ -n "$LOOP_PID" ] && ! kill -0 "$LOOP_PID" 2>/dev/null; then
    log "player loop ended; restarting"; sig=""             # rebuild on the next pass
  fi
  sleep 1
done
