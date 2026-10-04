# Sea sound player: one background process for the whole machine, shared by every Claude Code session.
# It synthesizes a looping wave sound (shaped noise) that follows the SAME schedule as the on-screen sea:
#  - every wave sounds different (the wave schedule),
#  - the sea sounds closer and louder at high tide, farther and softer at low tide (the tide),
#  - the tone changes with the scene (bright morning, deep night ...), following the scene cycle.
# It follows control.json (on/off, volume, scene, sync) and quits when it is switched off, when every
# session has gone quiet for 30 s, or when this script file is updated.
# ASCII only on purpose: Windows PowerShell 5.1 misreads a BOM-less UTF-8 file with non-ASCII text.
param(
  [string]$StateDir = "",     # folder with control.json, schedule.json and the heartbeat files (written by the mod)
  [double]$Volume = 0.30,     # defaults, used when there is no control file (and by -DryRun)
  [int]$SyncMs = 120,         # how much later than the on-screen wave the sound is
  [int]$Scene = -1,           # -1 = follow the 5-scene cycle (480 s loop), 0..4 = that scene only (96 s loop)
  [string]$MutexName = "Local\sea-sound-mod",   # one player per user session; tests use another name
  [string]$DryRun = ""        # when set, write the WAV there and exit (no sound)
)
$ErrorActionPreference = 'Stop'

# only one session may play the sea at a time (the mod loads in every session, and several can be open at once).
# A killed player leaves the mutex "abandoned", which still hands it over, so that case counts as acquired.
$mutex = $null
if ($DryRun -eq "") {
  $mutex = New-Object System.Threading.Mutex($false, $MutexName)
  $got = $false
  try { $got = $mutex.WaitOne(3000) } catch [System.Threading.AbandonedMutexException] { $got = $true }
  if (-not $got) { exit 0 }
}

$src = @'
using System;
using System.IO;

public static class SeaSynth
{
    const double WaveLoop = 96.0;
    const double SceneSec = 96.0;
    const int SceneCount = 5;

    static double Smooth(double x)
    {
        if (x < 0) x = 0;
        if (x > 1) x = 1;
        return x * x * (3 - 2 * x);
    }

    // scene parameters at loop time u: gain, hiss, wash, rumble cutoff Hz, wash cutoff Hz (cross-faded between scenes)
    static void SceneParams(double[] sp, int scene, double u, double[] p)
    {
        if (scene >= 0)
        {
            for (int k = 0; k < 5; k++) p[k] = sp[scene * 5 + k];
            return;
        }
        double pos = u / SceneSec;
        int a = (int)pos;
        double fr = pos - a;
        int b = (a + 1) % SceneCount;
        a = a % SceneCount;
        double m = Smooth((fr - 0.7) / 0.3);   // same cross-fade window as the picture
        for (int k = 0; k < 5; k++) p[k] = sp[a * 5 + k] * (1 - m) + sp[b * 5 + k] * m;
    }

    // 2) the sound: noise shaped by the water, tinted by the scene. Fills ch (nTotal + crossfade samples) and returns its peak.
    static double Fill(int rate, int scene, int baseIdx, int nTotal, int n96, float[] body, float[] foam, double[] sp, float[][] ch)
    {
        int f = rate / 5;                       // 0.2 s crossfade so the loop has no seam
        int total = nTotal + f;
        Random rnd = new Random(12345);
        double[] p = new double[5];
        for (int c = 0; c < 2; c++)
        {
            double l1 = 0, l2 = 0, m = 0;
            double lastLow = -1, lastMid = -1, aLow = 0, aMid = 0;
            for (int i = 0; i < total; i++)
            {
                int gi = baseIdx + i;
                int j = gi % n96;
                double u = (double)(gi % nTotal) / rate;
                SceneParams(sp, scene, u, p);
                if (p[3] != lastLow) { lastLow = p[3]; aLow = 1 - Math.Exp(-2 * Math.PI * lastLow / rate); }
                if (p[4] != lastMid) { lastMid = p[4]; aMid = 1 - Math.Exp(-2 * Math.PI * lastMid / rate); }
                double w = rnd.NextDouble() * 2 - 1;
                l1 += aLow * (w - l1);
                l2 += aLow * (l1 - l2);
                m += aMid * (w - m);
                double rumble = l2 * 3.0;
                double wash = (m - l1) * 1.3 * p[2];
                double hiss = (w - m) * 0.5 * p[1];
                ch[c][i] = (float)(p[0] * ((rumble + wash) * body[j] + hiss * foam[j] * body[j]));
            }
        }
        double peak = 1e-6;
        for (int c = 0; c < 2; c++)
        {
            for (int i = 0; i < nTotal; i++)
            {
                if (i < f)
                {
                    double w = (double)i / f;
                    ch[c][i] = (float)(ch[c][i] * w + ch[c][nTotal + i] * (1 - w));
                }
                double v = Math.Abs(ch[c][i]);
                if (v > peak) peak = v;
            }
        }
        return peak;
    }

    // Circularly shifts the PCM data of a WAV by shiftFrames frames (the loop is seamless, so the shifted loop is too).
    // Used when generation ran longer than planned: instead of playing out of step, start now at the later phase.
    public static byte[] Rotate(byte[] wav, int shiftFrames)
    {
        int frames = (wav.Length - 44) / 4;
        if (frames <= 0) return wav;
        int sh = ((shiftFrames % frames) + frames) % frames;
        if (sh == 0) return wav;
        byte[] o = new byte[wav.Length];
        Buffer.BlockCopy(wav, 0, o, 0, 44);
        int first = (frames - sh) * 4;
        Buffer.BlockCopy(wav, 44 + sh * 4, o, 44, first);
        Buffer.BlockCopy(wav, 44, o, 44 + first, sh * 4);
        return o;
    }

    // flat: groups of 4 = t, amp, rush, drain (seconds, within WaveLoop). tide: one value per 0.5 s over WaveLoop.
    // sp: 5 scenes x 5 parameters. scene: -1 follows the scene cycle. startPhase: where in the loop sample 0 sits.
    // The volume always refers to the loudest moment of the WHOLE scene cycle, so a quiet scene (night) stays
    // quieter than a bright one even when it is the only scene playing.
    public static byte[] Make(int rate, double volume, int scene, double startPhase, double[] flat, double[] tide, double[] sp)
    {
        int count = flat.Length / 4;
        int n96 = (int)(rate * WaveLoop);
        int nCycle = (int)(rate * SceneSec * SceneCount);
        int nTotal = scene >= 0 ? n96 : nCycle;
        int f = rate / 5;
        int tn = tide.Length;

        // 1) the water: waves + tide, one wave loop long (the scene cycle reuses it five times)
        float[] body = new float[n96];
        float[] foam = new float[n96];
        for (int j = 0; j < n96; j++)
        {
            double u = (double)j / rate;
            double ti = u * 2;
            int i0 = (int)ti;
            double fr = ti - i0;
            double tv = tide[i0 % tn] * (1 - fr) + tide[(i0 + 1) % tn] * fr;
            double near = (tv - 3.5) / 11.5;     // 0 = the water is far out, 1 = it is right up the beach
            if (near < 0) near = 0;
            if (near > 1) near = 1;

            double b = 0.06 + 0.08 * near;      // the sea never goes silent
            double fm = 0.0;
            for (int k = 0; k < count; k++)
            {
                double t0 = flat[k * 4], amp = flat[k * 4 + 1], rush = flat[k * 4 + 2], drain = flat[k * 4 + 3];
                double crash = rush * 0.85;
                for (int s = -1; s <= 1; s++)
                {
                    double tau = u - (t0 + s * WaveLoop);
                    if (tau < -0.8 || tau > rush + drain * 1.4) continue;
                    if (tau < crash)
                    {
                        double q = (tau + 0.8) / (crash + 0.8);        // the roar builds before the crash
                        double sn = Math.Sin(q * Math.PI / 2);
                        b += amp * sn * sn;
                        if (tau > 0) { double r = tau / crash; fm += amp * r * r; }
                    }
                    else
                    {
                        b += amp * Math.Exp(-(tau - crash) / (drain * 0.45));
                        fm += amp * Math.Exp(-(tau - crash) / (drain * 0.2));
                    }
                }
            }
            // slow irregular swell (whole cycles per loop, so it still wraps cleanly)
            double lfo = 1 + 0.12 * Math.Sin(2 * Math.PI * 37 * u / WaveLoop + 1) + 0.08 * Math.Sin(2 * Math.PI * 61 * u / WaveLoop + 2)
                           + 0.06 * Math.Sin(2 * Math.PI * 97 * u / WaveLoop + 4);
            body[j] = (float)(Math.Tanh(b * 1.1) * lfo * (0.6 + 0.55 * near));      // close = louder
            foam[j] = (float)(Math.Tanh(fm * 1.2) * lfo * (0.6 + 0.7 * near));      // close = more hiss
        }

        // 2) the sound
        float[][] ch = new float[2][];
        ch[0] = new float[nTotal + f];
        ch[1] = new float[nTotal + f];
        int baseIdx = (int)Math.Round(startPhase * rate);
        double peak = Fill(rate, scene, baseIdx, nTotal, n96, body, foam, sp, ch);
        if (scene >= 0)
        {
            // reference loudness: the loudest moment over the whole scene cycle
            float[][] all = new float[2][];
            all[0] = new float[nCycle + f];
            all[1] = new float[nCycle + f];
            double cyclePeak = Fill(rate, -1, 0, nCycle, n96, body, foam, sp, all);
            if (cyclePeak > peak) peak = cyclePeak;
        }
        double gain = volume / peak;

        MemoryStream ms = new MemoryStream(nTotal * 4 + 44);
        BinaryWriter bw = new BinaryWriter(ms);
        int dataLen = nTotal * 4;
        bw.Write(new char[] { 'R', 'I', 'F', 'F' });
        bw.Write(36 + dataLen);
        bw.Write(new char[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' });
        bw.Write(16);
        bw.Write((short)1);
        bw.Write((short)2);
        bw.Write(rate);
        bw.Write(rate * 4);
        bw.Write((short)4);
        bw.Write((short)16);
        bw.Write(new char[] { 'd', 'a', 't', 'a' });
        bw.Write(dataLen);
        for (int i = 0; i < nTotal; i++)
        {
            bw.Write((short)(ch[0][i] * gain * 32767));
            bw.Write((short)(ch[1][i] * gain * 32767));
        }
        bw.Flush();
        return ms.ToArray();
    }
}
'@
Add-Type -TypeDefinition $src

# the wave schedule + tide come from schedule.json, written by the mod, so they always match the picture
$schedPath = Join-Path $StateDir 'schedule.json'
$flatArr = $null
$tideArr = $null
function Read-Schedule {
  $j = Get-Content -Raw -Encoding UTF8 -Path $schedPath | ConvertFrom-Json
  $flat = New-Object System.Collections.Generic.List[double]
  foreach ($w in $j.waves) { $flat.Add([double]$w.t); $flat.Add([double]$w.amp); $flat.Add([double]$w.rush); $flat.Add([double]$w.drain) }
  $tl = New-Object System.Collections.Generic.List[double]
  foreach ($v in $j.tide) { $tl.Add([double]$v) }
  if ($flat.Count -lt 4) { throw "schedule.json has no waves" }
  if ($tl.Count -lt 2) { $tl.Add(9.25); $tl.Add(9.25) }
  $script:flatArr = $flat.ToArray()
  $script:tideArr = $tl.ToArray()
}

# per scene: gain, hiss, wash, rumble cutoff Hz, wash cutoff Hz   (morning, emerald noon, dusk, midnight, dawn)
$sp = [double[]]@(
  1.00, 1.00, 1.00, 500, 2500,
  1.05, 1.25, 1.00, 550, 2800,
  0.95, 0.80, 1.10, 420, 2200,
  0.75, 0.45, 0.80, 330, 1600,
  0.85, 0.65, 0.90, 400, 2000
)

# build the WAV for the moment playback will start ($startMs), so what it plays lines up with the screen
function New-Sea([double]$vol, [int]$sync, [int]$scene, [int64]$startMs) {
  $loopSec = 480
  if ($scene -ge 0) { $loopSec = 96 }
  $loopMs = [int64]($loopSec * 1000)
  $u0 = (($startMs - $sync) % $loopMs) / 1000.0
  if ($DryRun -ne "") { $u0 = 0.0 }
  return [SeaSynth]::Make(16000, $vol, $scene, $u0, $flatArr, $tideArr, $sp)
}

try { Read-Schedule } catch { if ($DryRun -eq "") { try { [System.IO.File]::AppendAllText((Join-Path $StateDir 'player.log'), ('schedule error: ' + $_.Exception.Message + [Environment]::NewLine)) } catch { } }; throw }
if ($DryRun -ne "") {
  $bytes = New-Sea $Volume $SyncMs $Scene 0
  [System.IO.File]::WriteAllBytes($DryRun, $bytes)
  exit 0
}

# ---- player: follows the shared control file, plays until no session is left ----
$aliveFile = Join-Path $StateDir 'player.alive'
$sessionsDir = Join-Path $StateDir 'sessions'
$controlFile = Join-Path $StateDir 'control.json'
$scriptPath = $PSCommandPath
$logFile = Join-Path $StateDir 'player.log'
function Write-Log([string]$msg) {
  try {
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 100000)) { Remove-Item $logFile -Force }
    [System.IO.File]::AppendAllText($logFile, ((Get-Date).ToString('HH:mm:ss') + ' [' + $PID + '] ' + $msg + [Environment]::NewLine))
  } catch { }
}
$scriptStamp = (Get-Item $scriptPath).LastWriteTimeUtc.Ticks
New-Item -ItemType Directory -Force -Path $sessionsDir | Out-Null

function Write-Alive {
  $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [System.IO.File]::WriteAllText($aliveFile, [string]$ms)
}
# A read can land in the middle of a write by a session. Retry once; if it still fails the caller keeps the last good values.
function Read-Control {
  for ($try = 0; $try -lt 2; $try++) {
    try { return (Get-Content -Raw -Encoding UTF8 -Path $controlFile | ConvertFrom-Json) } catch { Start-Sleep -Milliseconds 150 }
  }
  return $null
}
function Test-SessionAlive {
  $cut = (Get-Date).AddSeconds(-30)
  $any = Get-ChildItem -Path $sessionsDir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $cut } | Select-Object -First 1
  return ($null -ne $any)
}

Write-Log 'start'
$lastCtl = $null
$player = $null
$stream = $null
$sig = ""
$idle = 0
$loops = 0
while ($true) {
  $loops++
  Write-Alive
  $ctl = Read-Control
  if ($null -ne $ctl) { $lastCtl = $ctl } else { $ctl = $lastCtl }   # unreadable: keep the last good control, never fall back to loud defaults
  if ($null -ne $ctl -and $ctl.on -eq $false) { Write-Log 'exit: turned off'; break }       # turned off from any session
  if ((Get-Item $scriptPath).LastWriteTimeUtc.Ticks -ne $scriptStamp) { Write-Log 'exit: script updated'; break }   # updated: a fresh player takes over
  if (Test-SessionAlive) { $idle = 0 } else { $idle++ }
  if ($idle -ge 3) { Write-Log 'exit: no live session'; break }  # every session is closed
  if ($idle -gt 0) { Start-Sleep -Seconds 1; continue }        # no session yet: do not start playing
  if (($loops % 60) -eq 0) {                                   # tidy up heartbeat files of sessions long gone
    Get-ChildItem -Path $sessionsDir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-10) } | Remove-Item -Force -ErrorAction SilentlyContinue
  }

  $vol = $Volume
  $sync = $SyncMs
  $scn = $Scene
  if ($null -ne $ctl) { $vol = [double]$ctl.volume / 100.0; $sync = [int]$ctl.syncMs; $scn = [int]$ctl.scene }
  $schedStamp = (Get-Item $schedPath).LastWriteTimeUtc.Ticks
  $newSig = "$vol|$sync|$scn|$schedStamp"
  if ($newSig -ne $sig) {
    # volume / scene / sync / schedule changed (from any session): rebuild and restart on the right beat
    Write-Log ('build ' + $newSig)
    if ($null -ne $player) { $player.Stop(); $player.Dispose(); $player = $null }
    Read-Schedule
    $plannedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 4000
    $bytes = New-Sea $vol $sync $scn $plannedMs
    $lateMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 400 - $plannedMs
    if ($lateMs -gt 0) {
      # generation took longer than planned (a busy machine): start now, at the phase we have reached
      $bytes = [SeaSynth]::Rotate($bytes, [int]($lateMs * 16))
      Write-Log ('late by ' + $lateMs + ' ms, rotated')
    }
    $stream = New-Object System.IO.MemoryStream(, $bytes)
    $player = New-Object System.Media.SoundPlayer($stream)
    $player.Load()
    $wait = $plannedMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
    $player.PlayLooping()
    $sig = $newSig
    Write-Alive
    Write-Log 'playing'
  }
  Start-Sleep -Seconds 1
}
if ($null -ne $player) { $player.Stop() }
