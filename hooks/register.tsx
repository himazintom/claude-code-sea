import type { Elements, EngineInterface, Register, Timer } from 'claude-code'

import { actorsAt } from './actors'
import type { ActorKind, ForcedActor } from './actors'
import { LOOP, SCENES, WAVES, paintSea, tideSeries, toCells, toSvg } from './sea'

const PANE = 'sea' // 旧バージョンが開いたパネル。起動時に閉じる
const KEY = 'sea-raster'
const ROWS = 12 // 絵の高さ (端末の行数 = ドット数)。1 ドットは横 2 桁 × 縦 1 行
const FRAME_MS = 80 // 約 12fps
const DESKTOP_DOTS = 64 // デスクトップ (Svg) の横ドット数
const DESKTOP_DOT_PX = 10
const BEAT_EVERY = 5 // 制御ファイルは 1 秒おきに見る。生存の合図と音のプレーヤーの確認は、その 5 回に 1 回
const PLAYER_STALE_MS = 12000 // プレーヤーの合図がこれより古ければ、いないものとして起動し直す
const SPAWN_COOLDOWN_MS = 20000 // 起動の試行は、1 つのセッションにつきこの間隔まで
const SESSION_FRESH_MS = 30000 // 「生きているセッション」とみなす合図の新しさ
const FRAME_STALE_MS = 1500 // 描画タイマーの最後の動きがこれより古ければ止まったとみなして張り直す
const CONTROL_STALE_MS = 5000 // 制御タイマーも同様

// /sea の後ろに付けて今すぐ呼ぶ名前 → 動くものの種類
const ACTORS: Record<string, ActorKind> = {
  crab: 'walk',
  swept: 'swept',
  turtle: 'turtle',
  fish: 'fish',
  gull: 'gull',
  meteor: 'meteor',
  boat: 'boat',
  shell: 'shell',
}

// 場面の呼び名 → SCENES の添字
const NAMES: Record<string, number> = {
  morning: 0,
  noon: 1,
  emerald: 1,
  dusk: 2,
  sunset: 2,
  night: 3,
  dawn: 4,
}

const CONTROLS_MIN_COLS = 40 // 操作行を出す最小の幅
const VOLUME_STEP = 10 // [-] [+] 1 回あたりの音量
const GUIDE_VERSION = 1 // 案内を出し直したいときに上げる (導入後に 1 回だけ出す)
const BUSY_PLAY_MS = 6000 // 止めていた音を ON にしたあと、プレーヤーが起動して鳴り始めるまで操作を受けない時間
const BUSY_SCENE_MS = 3500 // 場面を切り替えたあと、プレーヤーが音を合成し直して入れ替えるまで
const BUSY_STOP_MS = 2000 // 音を止めたあと、プレーヤーが終わるまで
const DEDUPE_MS = 800 // 同じボタンの focus と press が続けて届いても、1 回しか実行しない

// 導入後に 1 回出す案内。[?] ボタンでいつでも出せる
const GUIDE = [
  '🌊 海 (sea): 入力欄の上に海が出ています',
  '  入力欄の上の操作行: [⏻ ON] 電源 (全セッションの海と音を止める/戻す) / [音 ON] 音の切り替え / [-] [+] 音量 / [場面] 場面を切り替え / [?] この案内',
  '  コマンド: /sea help (一覧) / /sea (電源を切る・入れる。全セッション共通) / /sea sound off (音だけ止める)',
].join('\n')

// /sea help の本文
const HELP = [
  '海 (sea) の操作',
  '',
  '入力欄の上の操作行 (クリック)',
  '  [⏻ ON] 電源 (全セッションの海と音を止める/戻す)   [音 ON] 音の ON/OFF',
  '  [-] [+] 音量   [場面:...] 場面を順に切り替え   [?] 案内を出す',
  '  電源を切ると、入力欄の上に [⏻ OFF] の 1 行だけが残ります。押すと全セッションで戻ります',
  '  その行の [×] で、行ごと閉じられます (全セッション共通。/sea で電源を入れ直せます)',
  '',
  'コマンド',
  '  /sea                 電源を切る/入れる (全セッションの海と音が一斉に止まる/戻る)',
  '  /sea on | off        電源を入れる/切る',
  '  /sea status          表示・音・プレーヤー・セッション数・直近のログを見る',
  '  /sea help            この一覧',
  '',
  '場面 (全セッション共通)',
  '  /sea morning | noon | dusk | night | dawn',
  '                       朝 / エメラルド / 夕焼け / 真夜中 / 明け方に固定する',
  '  /sea auto            時間とともに自動で巡らせる',
  '',
  '動くものを今すぐ呼ぶ (全セッションに出ます)',
  '  /sea crab | swept | turtle | fish | gull | meteor | boat | shell',
  '                       crab: Claude くん / swept: 波にさらわれる Claude くん',
  '                       turtle: ウミガメ / fish: 魚の群れ / gull: カモメの影',
  '                       meteor: 流れ星 (夜) / boat: 小舟 / shell: 貝殻とヒトデ',
  '',
  '波の音 (全セッション共通)',
  '  /sea sound           ON / OFF を切り替える',
  '  /sea sound on | off | 0-100',
  '                       ON / OFF / 音量 (0 は OFF)',
  '  /sea sync <ms>       音を画面の波より遅らせる量。音が先走るなら大きく (既定 120)',
].join('\n')

// ---- 全セッション共通の制御 ----
// 場面の固定・呼び出した動くもの・音の ON/OFF/音量/ずれ補正は、1 つの制御ファイルで管理する。
// どのセッションで操作しても、開いている全セッションの表示と音に反映される。
// 電源 (power) も同じ: 切ると全セッションの海が隠れて音も止まり、入れると全セッションに出て音も戻る。
// (波・潮位・場面の巡りは時計から決まるので、もともと全セッションで同じ)
// on = 波の音の ON/OFF、power = 海そのもの (絵と音) の電源、closed = 電源を切ったあとに残る 1 行を [×] で閉じたか
type Control = { on: boolean; power: boolean; closed: boolean; volume: number; syncMs: number; scene: number; forced: ForcedActor | null; rev: number }
const DEFAULT_CONTROL: Control = { on: true, power: true, closed: false, volume: 30, syncMs: 120, scene: -1, forced: null, rev: 0 }

// 音を出せない環境 (Windows 以外など) で、起動を何度も試して通知を連発しないための印
let soundBroken = false

// 状態の置き場。モッドのフォルダ (監視されていて、書くと再読み込みになる) の外にする
async function stateDirOf($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home}/.claude/sea-state` : `${$.plugin.root}/../sea-state`
}

async function readControl($: EngineInterface, dir: string): Promise<Control | undefined> {
  try {
    const text = (await $.fs.read(`${dir}/control.json`)) as string
    return { ...DEFAULT_CONTROL, ...JSON.parse(text) }
  } catch {
    return undefined
  }
}

// 制御ファイルを書き換える。読めなかったのが「まだ無い」のか「他のセッションが書いている最中」なのかを区別し、
// 後者なら少し待って読み直す。それでも読めなければ、既定値で上書きして設定を失わないよう、書かずに undefined を返す
async function writeControl($: EngineInterface, dir: string, patch: Partial<Control>): Promise<Control | undefined> {
  let cur = await readControl($, dir)
  for (let i = 0; i < 3 && !cur && (await $.fs.exists(`${dir}/control.json`)); i++) {
    await $.clock.sleep(80)
    cur = await readControl($, dir)
  }
  if (!cur && (await $.fs.exists(`${dir}/control.json`))) return undefined
  const next: Control = { ...DEFAULT_CONTROL, ...cur, ...patch, rev: (cur?.rev ?? 0) + 1 }
  await $.fs.write(`${dir}/control.json`, JSON.stringify(next))
  return next
}

// 波の予定表と潮位を、音のプレーヤーへファイルで渡す。画面と同じものを使うので、音が必ず絵と揃う。
// 中身が同じなら書き直さない (書き直すとプレーヤーが音を作り直すため)
async function writeSchedule($: EngineInterface, dir: string) {
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  const text = JSON.stringify({
    loop: LOOP,
    waves: WAVES.map(w => ({ t: r3(w.t), amp: r3(w.amp), rush: r3(w.rush), drain: r3(w.drain) })),
    tide: tideSeries().map(v => Math.round(v * 100) / 100),
  })
  try {
    if ((await $.fs.read(`${dir}/schedule.json`)) === text) return
  } catch {
    // 無ければ書く
  }
  await $.fs.write(`${dir}/schedule.json`, text)
}

// プレーヤーが 2 秒おきに書く合図。新しければ誰かが鳴らしている
async function playerAgeMs($: EngineInterface, dir: string, now: number): Promise<number> {
  try {
    const text = (await $.fs.read(`${dir}/player.alive`)) as string
    return now - Number(text)
  } catch {
    return Infinity
  }
}

async function countSessions($: EngineInterface, dir: string, now: number): Promise<number> {
  try {
    const entries = await $.fs.list(`${dir}/sessions`)
    return entries.filter(f => f.kind === 'file' && now - f.mtimeMs < SESSION_FRESH_MS).length
  } catch {
    return 0
  }
}

// プレーヤーが書いたログの末尾 (音が鳴らないときの手がかり)
async function tailLog($: EngineInterface, dir: string, n: number): Promise<string> {
  try {
    const text = (await $.fs.read(`${dir}/player.log`)) as string
    return text.trim().split('\n').slice(-n).map(l => `  ${l}`).join('\n')
  } catch {
    return ''
  }
}

// 音のプレーヤーを、どのセッションにも属さない常駐プロセスとして起動する。
//   Windows: sound/sea-sound.ps1 (PowerShell が波音を合成して再生する)
//   macOS / Linux: sound/sea-sound.sh (事前に書き出した波音のループを、OS の再生コマンドで鳴らす)
// セッションを閉じても止まらず、全セッションが閉じてしばらくたつか、/sea sound off で自分で終わる。
// 複数のセッションが同時に起動を試みても、プレーヤー側の排他 (Mutex / ロック) で 1 つしか動かない。
// 音量・場面・ずれ補正は、プレーヤーが制御ファイルを見て自分で追従する
async function launchPlayer($: EngineInterface, dir: string): Promise<boolean> {
  if ((await $.env.get('OS')) !== 'Windows_NT') {
    try {
      const r = await $.process.run(['sh', '-c', 'nohup sh "$0" "$1" >/dev/null 2>&1 &', `${$.plugin.root}/sound/sea-sound.sh`, dir], { timeoutMs: 20000 })
      return r.exitCode === 0
    } catch {
      return false
    }
  }
  const lit = (v: string) => `'"${v.replace(/'/g, "''")}"'`
  const script = `${$.plugin.root}/sound/sea-sound.ps1`
  const cmd =
    `Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList ` +
    `@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${lit(script)},'-StateDir',${lit(dir)})`
  try {
    const r = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd], { timeoutMs: 20000 })
    return r.exitCode === 0
  } catch {
    return false
  }
}

// ---- 画面上の操作行 ----
// ボタンの押下は ui.press フックで受ける (onPress 自体は何もしない)
function noop() {}

type ControlKind = 'power' | 'close' | 'sound' | 'vol-' | 'vol+' | 'scene'
const CONTROL_KEYS: Record<string, ControlKind | 'help'> = {
  'sea-power': 'power',
  'sea-close': 'close',
  'sea-sound': 'sound',
  'sea-vol-down': 'vol-',
  'sea-vol-up': 'vol+',
  'sea-scene': 'scene',
  'sea-help': 'help',
}

// ボタンに応じて制御ファイルを書き換える。読めなければ undefined (書かない)
async function pressControl($: EngineInterface, dir: string, kind: ControlKind): Promise<Control | undefined> {
  const cur = (await readControl($, dir)) ?? DEFAULT_CONTROL
  if (kind === 'power') return writeControl($, dir, { power: !cur.power, closed: false }) // 切るたびに、1 行は出し直す
  if (kind === 'close') return writeControl($, dir, { closed: true })
  if (kind === 'sound') return writeControl($, dir, { on: !cur.on })
  if (kind === 'vol-') return writeControl($, dir, { volume: Math.max(VOLUME_STEP, cur.volume - VOLUME_STEP) })
  if (kind === 'vol+') return writeControl($, dir, { on: true, volume: Math.min(100, cur.volume + VOLUME_STEP) })
  // 場面: 自動 → 朝 → 昼 → 夕焼け → 夜 → 明け方 → 自動
  return writeControl($, dir, { scene: cur.scene >= SCENES.length - 1 ? -1 : cur.scene + 1 })
}

// 操作の受付状態。音のプレーヤーが作り直されるあいだ (準備中) は、操作を受け付けない
type ControlGate = { busyUntil: number; lastEl: string; lastAt: number }

// クリックは ui.focus (ring が移る) → ui.press の順に届くが、再描画でボタンが作り直されると押下が空振りする。
// そこで ui.focus の時点で操作を実行し、focus は拒否する (ring も再描画も起きず、入力欄のキーも奪わない)。
// 後から押下が届いても二重に実行しないよう、同じボタンの操作は短時間つぶす
async function actOnControl($: EngineInterface, dir: string, element: string, gate: ControlGate): Promise<Control | undefined> {
  const kind = CONTROL_KEYS[element]
  if (!kind) return undefined
  const now = await $.clock.now()
  if (gate.lastEl === element && now - gate.lastAt < DEDUPE_MS) return undefined
  gate.lastEl = element
  gate.lastAt = now
  if (kind === 'help') {
    $.ui.log(GUIDE, { to: 'transcript' })
    return undefined
  }
  if (now < gate.busyUntil && kind !== 'power' && kind !== 'close') return undefined // 準備中 (電源と閉じるは、いつでも押せる)
  const before = await readControl($, dir)
  const ctl = await pressControl($, dir, kind)
  if (!ctl) {
    $.ui.toast('海: 制御ファイルを読めませんでした (ほかのセッションが書き込み中かもしれません)。もう一度押してください')
    return undefined
  }
  if (kind === 'power' || kind === 'close') {
    gate.busyUntil = 0 // 電源の切り替えは待たせない (音は、止める/戻すだけで、作り直さない)
    if (kind === 'close') $.ui.toast('海を閉じました。/sea で電源を入れ直せます', { timeoutMs: 6000 })
    $.ui.invalidate('ui.render')
    return ctl
  }
  // 受け付けない時間: 止めたあとはプレーヤーが終わるまで / 止まっていた音を鳴らすならプレーヤーの起動まで /
  // 場面の切り替えは音の合成し直しのあいだ。音量だけの変更は掛け直すだけなので待たない
  if (!ctl.on) gate.busyUntil = kind === 'sound' ? now + BUSY_STOP_MS : 0
  else if (before && !before.on) gate.busyUntil = now + BUSY_PLAY_MS
  else gate.busyUntil = kind === 'scene' ? now + BUSY_SCENE_MS : 0
  $.ui.invalidate('ui.render')
  return ctl
}

type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

// 音と場面の操作行。端末もデスクトップも同じ木 (デスクトップはネイティブのボタンで描かれる)。
// 準備中は押せるボタンを出さず、文字だけにする。終わると新しいボタンが出る
function controlRow(El: Els, soundOn: boolean, volume: number, scene: number, busy: boolean) {
  const { Box, Text, Button } = El
  const sceneName = scene >= 0 ? SCENES[scene].label.replace('の海', '') : '自動'
  if (busy) {
    // 準備中でも電源は押せる
    return (
      <Box flexDirection="row" gap={1}>
        <Button key="sea-power" plain label="[⏻ ON]" onPress={noop} />
        <Text bold>{soundOn ? '音 準備中…' : '音 停止中…'}</Text>
        <Text bold>{`音量 ${volume}`}</Text>
        <Text bold>{`場面:${sceneName}`}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="row" gap={1}>
      <Button key="sea-power" plain label="[⏻ ON]" onPress={noop} />
      <Button key="sea-sound" plain label={soundOn ? '[音 ON]' : '[音 OFF]'} onPress={noop} />
      <Button key="sea-vol-down" plain label="[-]" onPress={noop} />
      <Text bold>{`音量 ${volume}`}</Text>
      <Button key="sea-vol-up" plain label="[+]" onPress={noop} />
      <Button key="sea-scene" plain label={`[場面:${sceneName}]`} onPress={noop} />
      <Button key="sea-help" plain label="[?]" onPress={noop} />
    </Box>
  )
}

// 電源が切れているあいだ、入力欄の上に残す 1 行。押すと全セッションの海と音が戻る
function powerOffRow(El: Els) {
  const { Box, Text, Button } = El
  return (
    <Box flexDirection="row" gap={1}>
      <Button key="sea-power" plain label="[⏻ OFF]" onPress={noop} />
      <Text bold>海は停止中です。押すと全セッションに海と音が戻ります (/sea でも戻せます)</Text>
      <Button key="sea-close" plain role="dismiss" label="[×]" onPress={noop} />
    </Box>
  )
}

export const register: Register = on => {
  let dir = '' // 状態の置き場 (session.start で決まる)
  let sid = '' // このセッションの印 (合図のファイル名)
  const gate: ControlGate = { busyUntil: 0, lastEl: '', lastAt: 0 } // 操作行の受付状態
  let soundOn = true // 制御ファイルの音 ON/OFF (操作行の表示用)
  let volume = DEFAULT_CONTROL.volume // 同・音量
  let isOn = true // 海の電源。制御ファイルの power (全セッション共通)
  let barClosed = false // 電源が切れているときに残す 1 行を閉じたか。制御ファイルの closed (全セッション共通)
  let rows = ROWS // 直近に描いた高さ
  let label = ''
  let pinned: number | undefined // 制御ファイルの scene。undefined = 時間経過で自動ループ
  let forced: ForcedActor | undefined // 制御ファイルの forced。/sea <名前> で呼んだもの
  let frameTimer: Timer | undefined
  let controlTimer: Timer | undefined
  let lastFrameAt = 0 // 描画タイマーが最後に動いた時刻
  let lastControlAt = 0 // 制御タイマーが最後に動いた時刻
  let restartTimers: (() => void) | undefined // 止まったタイマーを張り直す (session.start で作る)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sea',
      description: '入力欄の上の海の電源 (全セッション共通)。/sea help でコマンド一覧',
    })
    await $.ui.close({ id: PANE }) // 旧パネルの掃除

    dir = await stateDirOf($)
    await writeSchedule($, dir)

    // 制御ファイルが無ければ、以前の設定 ($.store) を引き継いで作る
    if (!(await readControl($, dir))) {
      const saved = (await $.store.get('sound2')) as { isOn?: boolean; volume?: number; syncMs?: number } | undefined
      await writeControl($, dir, {
        on: saved ? saved.isOn !== false : true,
        volume: typeof saved?.volume === 'number' ? saved.volume : DEFAULT_CONTROL.volume,
        syncMs: typeof saved?.syncMs === 'number' ? saved.syncMs : DEFAULT_CONTROL.syncMs,
      })
    }

    // 導入後の最初のセッションで 1 回だけ、操作方法の案内を出す (GUIDE_VERSION を上げると出し直す)
    try {
      if (Number((await $.store.get('guide')) ?? 0) < GUIDE_VERSION) {
        await $.store.set('guide', GUIDE_VERSION)
        $.ui.log(GUIDE, { to: 'transcript' })
        $.ui.toast('海: 入力欄の上のボタンで音量・場面を操作できます。[?] で案内、/sea help で一覧', { timeoutMs: 10000 })
      }
    } catch {
      // 案内が出せなくても海は動かす
    }

    // 制御ファイルを 1 秒おきに見て、場面・動くものを全セッションで揃える。
    // 5 秒おきに「このセッションは生きている」の合図を書き、プレーヤーがいなければ起動する
    sid = Math.floor(Math.random() * 1e9).toString(36)
    let ticks = 0
    let lastSpawn = 0
    let quickRetries = 0 // 起動してもすぐ止まる状態が続いた回数
    const controlTick = async () => {
      lastControlAt = await $.clock.now()
      try {
        const ctl = await readControl($, dir)
        if (ctl) {
          pinned = ctl.scene >= 0 ? ctl.scene : undefined
          forced = ctl.forced ?? undefined
          soundOn = ctl.on
          volume = ctl.volume
          if (ctl.power !== isOn || ctl.closed !== barClosed) {
            // 電源か [×] が、どこかのセッションで切り替えられた: 海を出す/隠す/閉じるを揃える
            isOn = ctl.power
            barClosed = ctl.closed
            label = ''
            if (isOn) ticks = 0 // 戻ったら、すぐ生存の合図とプレーヤーの確認を行う
            $.ui.invalidate('ui.render')
          }
        }
        ticks += 1
        if (ticks % BEAT_EVERY !== 1) return
        const now = await $.clock.now()
        await $.fs.write(`${dir}/sessions/${sid}.txt`, String(now))
        if (ctl?.on !== false && ctl?.power !== false && !soundBroken && now - lastSpawn > SPAWN_COOLDOWN_MS && (await playerAgeMs($, dir, now)) > PLAYER_STALE_MS) {
          // 起動してもすぐ止まる (音声の再生コマンドが無いなど) 状態が続いたら、あきらめて 1 回だけ知らせる
          quickRetries = now - lastSpawn < 90000 ? quickRetries + 1 : 0
          lastSpawn = now
          if (quickRetries >= 3 || !(await launchPlayer($, dir))) {
            soundBroken = true
            $.ui.toast('海: 波の音を鳴らせませんでした。/sea status で理由を確認できます (Windows は PowerShell、macOS / Linux は sh と音声の再生コマンドが必要)。/sea sound on で再試行します')
          }
        }
      } catch {
        // 1 回の失敗で止めない。次の周期でやり直す
      }
    }

    // 絵は毎フレーム、エンジンに描き直してもらう。部分書き換え (blit) は、バンドがクリックや折りたたみで
    // 作り直されたときに対象を見失って止まるので使わない。
    // タイマーは「その周期が拒否されると終わる」ので、止まったら描画のたびに気づいて張り直す (render フック)
    const frameTick = async () => {
      lastFrameAt = await $.clock.now()
      if (isOn) $.ui.invalidate('ui.render')
    }
    restartTimers = () => {
      frameTimer?.cancel()
      controlTimer?.cancel()
      frameTimer = $.clock.every(FRAME_MS, frameTick)
      controlTimer = $.clock.every(1000, controlTick)
    }
    lastFrameAt = await $.clock.now()
    lastControlAt = lastFrameAt
    restartTimers()

    return next(e)
  })

  on('command.run', { command: 'sea' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (dir === '') dir = await stateDirOf($)
    const BUSY = { text: '海: 制御ファイルを読めませんでした (ほかのセッションが書き込み中かもしれません)。もう一度実行してください。' }

    if (arg === 'help' || arg === '?' || arg === '-h' || arg === '--help') return { text: HELP }
    if (arg === 'auto') {
      pinned = undefined
      if (!(await writeControl($, dir, { scene: -1 }))) return BUSY
      return { text: '海 (全セッション共通): 時間経過で朝→昼→夕焼け→夜→明け方と巡ります。' }
    }
    if (arg in NAMES) {
      pinned = NAMES[arg]
      if (!(await writeControl($, dir, { scene: pinned }))) return BUSY
      return { text: `海 (全セッション共通): ${SCENES[pinned].label}に固定しました。/sea auto で元に戻ります。` }
    }
    if (arg in ACTORS) {
      const call = { kind: ACTORS[arg], atMs: await $.clock.now() }
      forced = call
      if (!(await writeControl($, dir, { forced: call }))) return BUSY
      return { text: `${arg} を呼びました (全セッションに出ます)。` }
    }
    if (arg === 'status') {
      const now = await $.clock.now()
      const ctl = (await readControl($, dir)) ?? DEFAULT_CONTROL
      const age = await playerAgeMs($, dir, now)
      const sessions = await countSessions($, dir, now)
      const tail = age >= PLAYER_STALE_MS ? await tailLog($, dir, 3) : ''
      const lines = [
        `電源: ${ctl.power ? 'ON' : ctl.closed ? 'OFF (海も音も停止中・1 行も閉じ済み)' : 'OFF (海も音も停止中)'} (全セッション共通) / 場面: ${ctl.scene >= 0 ? SCENES[ctl.scene].label : '自動で巡る'}`,
        `音: ${ctl.on ? 'ON' : 'OFF'} / 音量 ${ctl.volume} / ずれ補正 ${ctl.syncMs}ms`,
        `プレーヤー: ${age < PLAYER_STALE_MS ? `稼働中 (合図 ${(age / 1000).toFixed(1)} 秒前)` : '停止'}${soundBroken ? ' / 起動に失敗した印あり' : ''}`,
        `生きているセッション: ${sessions}`,
        `状態の置き場: ${dir}`,
        ...(tail ? [`直近のプレーヤーのログ:\n${tail}`] : []),
      ]
      return { text: lines.join('\n') }
    }
    if (arg.startsWith('sync')) {
      const word = arg.slice(4).trim()
      const ms = Number(word)
      const cur = (await readControl($, dir)) ?? DEFAULT_CONTROL
      if (word === '' || !Number.isFinite(ms)) {
        return { text: `音のずれ補正: ${cur.syncMs}ms。/sea sync <ms> で変更 (大きいほど音が遅れる。音が画面より早ければ増やす)` }
      }
      const syncMs = Math.max(-2000, Math.min(2000, Math.round(ms)))
      if (!(await writeControl($, dir, { syncMs }))) return BUSY
      return { text: `音のずれ補正 (全セッション共通): ${syncMs}ms に設定しました。数秒後に鳴らし直されます。` }
    }
    if (arg === 'sound' || arg.startsWith('sound ')) {
      const word = arg.slice(5).trim()
      const pct = Number(word)
      const cur = (await readControl($, dir)) ?? DEFAULT_CONTROL
      let soundOn = cur.on
      let volume = cur.volume
      if (word === 'off') soundOn = false
      else if (word === 'on') soundOn = true
      else if (word === '') soundOn = !soundOn
      else if (Number.isFinite(pct)) {
        soundOn = pct > 0
        if (pct > 0) volume = Math.min(100, Math.round(pct))
      } else return { text: '海: /sea sound [on | off | 0-100]' }
      if (soundOn) soundBroken = false // 付け直したら、起動の失敗の印を消して再試行する
      if (!(await writeControl($, dir, { on: soundOn, volume }))) return BUSY
      return { text: soundOn ? `波の音 (全セッション共通): ON (音量 ${volume})。数秒後に鳴り始めます。` : '波の音 (全セッション共通): OFF' }
    }
    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return {
        text: '海: 使い方が違います。/sea help でコマンド一覧を見られます。',
      }
    }

    // 引数なし: 電源を切り替える。全セッションの海と音が一斉に止まる/戻る。on / off で指定もできる
    const cur = (await readControl($, dir)) ?? DEFAULT_CONTROL
    const power = arg === 'on' ? true : arg === 'off' ? false : !cur.power
    const next = await writeControl($, dir, { power, closed: false })
    if (!next) return BUSY
    if (next.on && next.power) soundBroken = false
    isOn = next.power
    barClosed = false
    label = ''
    $.ui.invalidate('ui.render')
    return {
      text: isOn
        ? '海の電源を入れました (全セッションに海が出て、音も戻ります)。'
        : '海の電源を切りました (全セッションの海を隠し、音も止めます)。/sea または 入力欄の上の [⏻ OFF] で戻せます ([×] で 1 行ごと閉じることもできます)。',
    }
  })

  // 操作の結果を、このセッションの表示用の状態に取り込む
  const takeControl = (ctl: Control | undefined) => {
    if (!ctl) return
    if (ctl.on) soundBroken = false // 付け直したら、起動の失敗の印を消して再試行する
    pinned = ctl.scene >= 0 ? ctl.scene : undefined
    soundOn = ctl.on
    volume = ctl.volume
    if (ctl.power !== isOn || ctl.closed !== barClosed) {
      isOn = ctl.power
      barClosed = ctl.closed
      label = ''
    }
  }

  // 海は表示専用。クリックされても入力欄からキーを奪わない (奪われると、Esc を押すまで入力できず固まって見える)。
  // 操作行のボタンはクリックが ui.focus として届くので、ここで操作を実行してから focus を拒否する
  // (電源が切れているあいだに残す [⏻ OFF] も同じ)
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.element !== undefined && e.element in CONTROL_KEYS) {
      if (dir === '') dir = await stateDirOf($)
      takeControl(await actOnControl($, dir, e.element, gate))
      return { deny: '海は表示専用です' }
    }
    if (isOn && e.element === undefined) return { deny: '海は表示専用です' }
    return next(e)
  })

  // 操作行のボタン (Enter やホットキーなど、focus を経ない押下)。音の ON/OFF・音量・場面は制御ファイルに書く
  on('ui.press', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(e.element in CONTROL_KEYS)) return next(e)
    if (dir === '') dir = await stateDirOf($)
    takeControl(await actOnControl($, dir, e.element, gate))
    return { element: e.element }
  })

  // 入力欄の真上のバンド
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    // 電源が切れているあいだは、戻すための 1 行だけを残す
    if (!isOn) {
      if (label !== 'off') {
        label = 'off'
        $.ui.status('🌊 停止中')
      }
      if (barClosed) return next(e) // [×] で閉じた: 何も出さない (/sea で戻る)
      return powerOffRow($.ui.resolve(e))
    }
    if (e.props.maxRows < 4) return next(e)

    // 操作行 (1 行) を絵の下に付ける。高さか幅が足りなければ絵だけ
    const showControls = e.props.maxRows >= 5 && e.props.bodyColumns >= CONTROLS_MIN_COLS
    rows = Math.min(ROWS, e.props.maxRows - (showControls ? 1 : 0))
    const now = await $.clock.now()
    if (now - lastFrameAt > FRAME_STALE_MS || now - lastControlAt > CONTROL_STALE_MS) restartTimers?.() // 止まっていたら張り直す

    if (e.surface === 'terminal') {
      const el = $.ui.resolve(e)
      const { Raster, Box } = el
      const cols = Math.max(8, Math.min(512, e.props.bodyColumns))
      const paint = paintSea(Math.max(1, cols >> 1), rows, now, pinned)
      const cells = toCells(paint, cols, actorsAt(now, cols, rows, pinned, forced))
      if (paint.label !== label) {
        label = paint.label
        $.ui.status(`🌊 ${label}`)
      }

      if (!showControls) return <Raster key={KEY} columns={cols} rows={rows} cells={cells} />
      return (
        <Box flexDirection="column">
          <Raster key={KEY} columns={cols} rows={rows} cells={cells} />
          {controlRow(el, soundOn, volume, pinned ?? -1, now < gate.busyUntil)}
        </Box>
      )
    }

    // デスクトップ: Raster が無いので Svg で描く
    const el = $.ui.resolve(e)
    const { Svg, Box } = el
    const paint = paintSea(DESKTOP_DOTS, rows, now, pinned)
    const actors = actorsAt(now, DESKTOP_DOTS * 2, rows, pinned, forced)
    if (paint.label !== label) {
      label = paint.label
      $.ui.status(`🌊 ${label}`)
    }

    const svg = <Svg source={toSvg(paint, DESKTOP_DOT_PX, actors)} alt={`海 (${paint.label})`} />
    if (!showControls) return svg
    return (
      <Box flexDirection="column">
        {svg}
        {controlRow(el, soundOn, volume, pinned ?? -1, now < gate.busyUntil)}
      </Box>
    )
  })
}
