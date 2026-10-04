import type { EngineInterface, Register, Timer } from 'claude-code'

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

// /sea help の本文
const HELP = [
  '海 (sea) のコマンド',
  '',
  '  /sea                 このセッションの表示を切り替える (音は止まりません)',
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
// (波・潮位・場面の巡りは時計から決まるので、もともと全セッションで同じ。表示の ON/OFF だけセッションごと)
type Control = { on: boolean; volume: number; syncMs: number; scene: number; forced: ForcedActor | null; rev: number }
const DEFAULT_CONTROL: Control = { on: true, volume: 30, syncMs: 120, scene: -1, forced: null, rev: 0 }

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

export const register: Register = on => {
  let dir = '' // 状態の置き場 (session.start で決まる)
  let isOn = true // /sea で切り替える (セッションごと)
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
      description: '入力欄の上の海を表示/非表示。/sea help でコマンド一覧',
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

    // 制御ファイルを 1 秒おきに見て、場面・動くものを全セッションで揃える。
    // 5 秒おきに「このセッションは生きている」の合図を書き、プレーヤーがいなければ起動する
    const sid = Math.floor(Math.random() * 1e9).toString(36)
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
        }
        ticks += 1
        if (ticks % BEAT_EVERY !== 1) return
        const now = await $.clock.now()
        await $.fs.write(`${dir}/sessions/${sid}.txt`, String(now))
        if (ctl?.on !== false && !soundBroken && now - lastSpawn > SPAWN_COOLDOWN_MS && (await playerAgeMs($, dir, now)) > PLAYER_STALE_MS) {
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
        `表示: ${isOn ? 'ON' : 'OFF'} (このセッション) / 場面: ${ctl.scene >= 0 ? SCENES[ctl.scene].label : '自動で巡る'}`,
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
    if (arg !== '') {
      return {
        text: '海: 使い方が違います。/sea help でコマンド一覧を見られます。',
      }
    }

    // 引数なし: このセッションの表示だけを切り替える (音は全セッション共通なので止めない)
    isOn = !isOn
    $.ui.invalidate('ui.render')
    if (!isOn) $.ui.status(undefined)
    return { text: isOn ? '海を表示します。' : '海を隠しました (このセッションだけ)。/sea でまた見られます。' }
  })

  // 海は表示専用。クリックされても入力欄からキーを奪わない (奪われると、Esc を押すまで入力できず固まって見える)
  on('ui.focus', { component: 'AbovePrompt' }, ($, e, next) => {
    if (isOn && e.element === undefined) return { deny: '海は表示専用です' }
    return next(e)
  })

  // 入力欄の真上のバンド
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isOn || e.props.hasSurvey || e.props.maxRows < 4) return next(e)

    rows = Math.min(ROWS, e.props.maxRows)
    const now = await $.clock.now()
    if (now - lastFrameAt > FRAME_STALE_MS || now - lastControlAt > CONTROL_STALE_MS) restartTimers?.() // 止まっていたら張り直す

    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const cols = Math.max(8, Math.min(512, e.props.bodyColumns))
      const paint = paintSea(Math.max(1, cols >> 1), rows, now, pinned)
      const cells = toCells(paint, cols, actorsAt(now, cols, rows, pinned, forced))
      if (paint.label !== label) {
        label = paint.label
        $.ui.status(`🌊 ${label}`)
      }

      return <Raster key={KEY} columns={cols} rows={rows} cells={cells} />
    }

    // デスクトップ: Raster が無いので Svg で描く
    const { Svg } = $.ui.resolve(e)
    const paint = paintSea(DESKTOP_DOTS, rows, now, pinned)
    const actors = actorsAt(now, DESKTOP_DOTS * 2, rows, pinned, forced)
    if (paint.label !== label) {
      label = paint.label
      $.ui.status(`🌊 ${label}`)
    }

    return <Svg source={toSvg(paint, DESKTOP_DOT_PX, actors)} alt={`海 (${paint.label})`} />
  })
}
