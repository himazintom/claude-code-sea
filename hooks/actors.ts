// 砂浜や海に現れる動くもの。時刻だけで決まる (状態を持たない) ので、再読み込みしても続きから動く。
// 座標は「細かいドット」: 横 1 桁 = 1、縦は半行 = 1 (端末の 1 行 = 2)。

import { SHADE, hash, nextSurgeAfter, sceneIndexAt, swashAt, tideAt } from './sea'
import type { Pix } from './sea'

export type ActorKind = 'walk' | 'swept' | 'turtle' | 'fish' | 'gull' | 'meteor' | 'boat' | 'shell'
export type ForcedActor = { kind: ActorKind; atMs: number }

const LEGEND: Record<string, number> = {
  O: 0xd97757, // Claude のオレンジ
  o: 0xa8472c,
  K: 0x1c1210,
  W: 0xf2fbff, // 泡
  G: 0x4f9d69, // ウミガメの甲羅
  g: 0x2f6b47,
  Y: 0xa7c957,
  s: SHADE + 38, // 影 (下の色を 38% 暗くする)
  f: SHADE + 30, // 魚影
  B: 0x7a4a2e, // 小舟の船体
  b: 0xb98254,
  R: 0xe0705a, // ヒトデ
  P: 0xf6e3da, // 貝殻
  p: 0xe3a9a0,
}

function stamp(art: readonly string[], x: number, y: number, isFlipX = false, isFlipY = false): Pix[] {
  const out: Pix[] = []
  const h = art.length
  const ox = Math.round(x)
  const oy = Math.round(y)
  for (let r = 0; r < h; r++) {
    const row = art[isFlipY ? h - 1 - r : r]
    const w = row.length
    for (let q = 0; q < w; q++) {
      const c = LEGEND[row[isFlipX ? w - 1 - q : q]]
      if (c !== undefined) out.push({ x: ox + q, y: oy + r, c })
    }
  }
  return out
}

// ---- Claude くん (蟹の代わり) ----
const BODY = [
  'O............O',
  'OO..OOOOOO..OO',
  '.OOOOOOOOOOOO.',
  '.OOKOOOOOOKOO.',
  '.OOKOOOOOOKOO.',
  '..OOOOOOOOOO..',
]
const CLAUDE_STAND = BODY.concat(['..o.o....o.o..', '.o..o....o..o.'])
const CLAUDE_STEP = BODY.concat(['...o.o..o.o...', '..o..o..o..o..'])
// 波にのまれてバンザイ。ハサミを高く上げ、足をばたつかせる
const CLAUDE_HELP = [
  'OO..........OO',
  'OO..OOOOOO..OO',
  '.OOOOOOOOOOOO.',
  '.OOKOOOOOOKOO.',
  '.OOKOOOOOOKOO.',
  '..OOOOOOOOOO..',
  '.o.o......o.o.',
  'o...o....o...o',
]
const SPR_W = 14
const SPR_H = 8

const SPEED = 14 // 歩く速さ (桁/秒)
const MOVE = 1.2 // 歩く秒数 (その後 0.8 秒立ち止まる。周期 2 秒)

// 歩いた距離 (桁) ↔ 経過秒。歩いては立ち止まりを繰り返す。映像制作が足音を合わせるため公開する
export function walkDist(local: number): number {
  const cycles = Math.floor(local / 2)
  return (cycles * MOVE + Math.min(local - cycles * 2, MOVE)) * SPEED
}
export function walkTime(dist: number): number {
  const per = MOVE * SPEED
  const cycles = Math.floor(dist / per)
  return cycles * 2 + (dist - cycles * per) / SPEED
}

// 砂浜を横切る
function walk(t: number, start: number, seed: number, columns: number, rows: number): Pix[] {
  const local = t - start
  if (local < 0) return []
  const dist = walkDist(local)
  if (dist > columns + SPR_W) return []
  const isMoving = local - Math.floor(local / 2) * 2 < MOVE
  const step = Math.floor(local * 5) % 2 // 歩き中は 5Hz で足を交互に
  const isRight = hash(seed, 9, 3) < 0.5
  const lane = Math.floor(hash(seed, 10, 4) * 3) // 砂浜の奥行き (半行 0..2)
  const hop = isMoving && step === 0 ? 1 : 0 // ひょこっと跳ねる
  const x = isRight ? dist - SPR_W : columns - dist
  return stamp(isMoving && step === 1 ? CLAUDE_STEP : CLAUDE_STAND, x, rows * 2 - SPR_H - lane - hop, !isRight)
}

// 波にさらわれる演出の時刻表。描画 (swept) と、効果音を合わせたい映像制作の両方が使う
export type SweptPlan = {
  isRight: boolean
  x0: number // 立ち止まる位置 (桁)
  d0: number // 画面の端からそこまで歩く距離
  tw: number // 歩いている秒数
  t0: number // 歩き出す時刻 (秒、時計の絶対時刻)
  cx: number // 体の中心 (桁)
  y0: number // 立つ高さ (半行)
  hit: number // 波が体に届く時刻。届かなければ -1
  end: number // 沖へ流されきって沈む時刻。hit が -1 なら -1
}

export function sweptPlan(start: number, seed: number, columns: number, rows: number): SweptPlan {
  const isRight = hash(seed, 9, 3) < 0.5
  let x0 = Math.round(columns * (0.25 + 0.5 * hash(seed, 11, 5)))
  let d0 = isRight ? x0 + SPR_W : columns - x0
  if (d0 > 100) {
    d0 = 100
    x0 = isRight ? 100 - SPR_W : columns - 100
  }
  const tw = walkTime(d0)
  // 立ち止まったあと、最初に来る大きな波に合わせて歩き出す
  const surge = nextSurgeAfter(start + 2 + tw, 0.6)
  const t0 = surge - tw - 1.2
  const cx = x0 + SPR_W / 2
  // 立つ高さは潮位に合わせる (水の中に立たない。ただし画面の下端を超えない)
  const y0 = Math.max(0, Math.min(rows * 2 - SPR_H, tideAt(t0 + tw, cx) + 2))

  // 波が体に届く瞬間を探す
  let hit = -1
  for (let ts = t0 + tw; ts < t0 + tw + 12; ts += 0.05) {
    if (swashAt(ts, cx).front >= y0 + 2) {
      hit = ts
      break
    }
  }
  let end = -1
  if (hit >= 0) {
    end = hit + 8
    for (let ts = hit + 1; ts < hit + 8; ts += 0.05) {
      const sw = swashAt(ts, cx)
      if (sw.front <= sw.base + 1.8) {
        end = ts
        break
      }
    }
  }
  return { isRight, x0, d0, tw, t0, cx, y0, hit, end }
}

// 波にさらわれる: 砂浜に歩いてきて立ち止まる → 大きな波にのまれる → 引き波で沖へ流されて、泡になって消える
function swept(t: number, start: number, seed: number, columns: number, rows: number): Pix[] {
  const { isRight, x0, d0, tw, t0, cx, y0, hit, end } = sweptPlan(start, seed, columns, rows)
  const local = t - t0
  if (local < 0) return []

  if (local < tw) {
    const dist = Math.min(walkDist(local), d0)
    const isMoving = local - Math.floor(local / 2) * 2 < MOVE
    const step = Math.floor(local * 5) % 2
    const x = isRight ? dist - SPR_W : columns - dist
    return stamp(isMoving && step === 1 ? CLAUDE_STEP : CLAUDE_STAND, x, y0 - (isMoving && step === 0 ? 1 : 0), !isRight)
  }

  if (hit < 0) return stamp(CLAUDE_STAND, x0, y0, !isRight)
  if (t < hit) {
    const isStartled = hit - t < 0.5 // 波に気づいてビクッ
    return stamp(isStartled ? CLAUDE_HELP : CLAUDE_STAND, x0, y0 - (isStartled ? 1 : 0), !isRight)
  }

  // 波の縁に乗って運ばれる。寄せで手前へ、引き波で沖へ
  const dir = isRight ? 1 : -1
  const carried = (ts: number) => {
    const tc = ts - hit
    return {
      x: x0 + dir * 2.5 * tc,
      // 手前へ押されても、帯の下端 (半行 rows*2) からはみ出さない
      y: Math.min(y0 + 4, swashAt(ts, cx).front - 4, rows * 2 - SPR_H - 1.3) + 1.2 * Math.sin(tc * 7), // 揺れの振れ幅 (1.2) ぶん内側で止める
    }
  }
  if (t < end) {
    const { x, y } = carried(t)
    const i = Math.floor((t - hit) * 3.5) % 4 // くるくる回る
    if (i === 0) return stamp(CLAUDE_HELP, x, y)
    if (i === 1) return stamp(CLAUDE_HELP, x, y, false, true)
    if (i === 2) return stamp(CLAUDE_STAND, x, y, true, true)
    return stamp(CLAUDE_HELP, x, y, true)
  }

  // 沈んで、泡だけが浮かぶ
  const since = t - end
  if (since > 1.8) return []
  const last = carried(end)
  const out: Pix[] = []
  for (let k = 0; k < 6; k++) {
    const bx = last.x + 2 + ((k * 5) % 11)
    const by = last.y + 5 - since * (2.5 + (k % 3)) - k
    out.push({ x: Math.round(bx), y: Math.round(by), c: LEGEND.W })
  }
  return out
}

// ---- ウミガメ (真上から見て、ゆっくり泳ぐ) ----
const TURTLE_A = [
  '..YY....YY..',
  '..YYGGGGYY..',
  '...GGggGGG..',
  '..GGgGGgGGYY',
  '..GGgGGgGGYY',
  '...GGggGGG..',
  '..YYGGGGYY..',
  '..YY....YY..',
]
const TURTLE_B = [
  '.YY......YY.',
  '..YYGGGGYY..',
  '...GGggGGG..',
  '..GGgGGgGGYY',
  '..GGgGGgGGYY',
  '...GGggGGG..',
  '..YYGGGGYY..',
  '.YY......YY.',
]

function turtle(t: number, start: number, seed: number, columns: number): Pix[] {
  const local = t - start
  if (local < 0) return []
  const speed = Math.max(6, (columns + 12) / 45)
  const dist = local * speed
  if (dist > columns + 12) return []
  const isRight = hash(seed, 9, 3) < 0.5
  const y = Math.floor(hash(seed, 10, 4) * 3) + 1.3 * Math.sin(local * 0.7) // のんびり蛇行
  return stamp(Math.floor(local * 1.6) % 2 === 0 ? TURTLE_A : TURTLE_B, isRight ? dist - 12 : columns - dist, y, !isRight)
}

// ---- 魚の群れ (真上から見た影) ----
const FISH_A = ['.fff', 'fff.']
const FISH_B = ['fff.', '.fff']
const SCHOOL = [
  [0, 0],
  [-6, 2],
  [-6, -2],
  [-12, 0],
  [-12, 4],
  [-18, 1],
]

function fish(t: number, start: number, seed: number, columns: number): Pix[] {
  const local = t - start
  if (local < 0) return []
  const dist = local * 9
  if (dist > columns + 30) return []
  const isRight = hash(seed, 9, 3) < 0.5
  const baseY = 1 + Math.floor(hash(seed, 10, 4) * 3)
  const out: Pix[] = []
  SCHOOL.forEach(([ox, oy], i) => {
    const wiggle = 1.2 * Math.sin(local * 2.2 + i)
    const frame = Math.floor(local * 6 + i) % 2 === 0 ? FISH_A : FISH_B
    const x = isRight ? dist + ox : columns - dist - ox
    out.push(...stamp(frame, x, baseY + oy + wiggle, !isRight))
  })
  return out
}

// ---- カモメの影 (頭上を横切る) ----
const GULL_A = ['ss.......ss', '.sssssssss.', '...sssss...', '....sss....']
const GULL_B = ['...s...s...', '..sssssss..', '...sssss...', '....sss....']

function gull(t: number, start: number, seed: number, columns: number, rows: number): Pix[] {
  const local = t - start
  if (local < 0) return []
  const dist = local * 22
  if (dist > columns + 11) return []
  const isRight = hash(seed, 9, 3) < 0.5
  const y = rows * 2 * (0.1 + 0.25 * hash(seed, 10, 4)) + dist * 0.12
  return stamp(Math.floor(local * 6) % 2 === 0 ? GULL_A : GULL_B, isRight ? dist - 11 : columns - dist, y, !isRight)
}

// ---- 流れ星 (夜と明け方、水面に映る) ----
const TRAIL = [0xffffff, 0xeef2ff, 0xdbe4ff, 0xb0c0e8, 0x8a9cc8, 0x6d80b0]

function meteor(t: number, start: number, seed: number, columns: number): Pix[] {
  const local = t - start
  if (local < 0 || local > 0.9) return []
  const isRight = hash(seed, 9, 3) < 0.5
  const dx = isRight ? 1 : -1
  const hx = columns * (0.1 + 0.8 * hash(seed, 11, 5)) + dx * 40 * local
  const hy = 1 + 4 * hash(seed, 10, 4) + 14 * local
  return TRAIL.map((c, i) => ({ x: Math.round(hx - dx * i * 1.7), y: Math.round(hy - i * 0.6), c }))
}

// ---- 小舟 (沖をゆっくり横切る。航跡つき) ----
const BOAT = ['....WW.....', '..WWWWW....', 'BBBBBBBBBB.', '.BbbbbbbbBB']

function boat(t: number, start: number, seed: number, columns: number): Pix[] {
  const local = t - start
  if (local < 0) return []
  const speed = Math.max(3.5, (columns + 25) / 50)
  const dist = local * speed
  if (dist > columns + 25) return []
  const isRight = hash(seed, 9, 3) < 0.5
  const y = Math.floor(hash(seed, 10, 4) * 2) + 0.5 * Math.sin(local * 0.8) // 波に揺られる
  const x = isRight ? dist - 11 : columns - dist
  const out = stamp(BOAT, x, y, !isRight)
  for (let k = 1; k <= 6; k++) {
    const wx = isRight ? x - k * 2.2 : x + 10 + k * 2.2
    out.push({ x: Math.round(wx), y: Math.round(y + 3 + ((k + Math.floor(local * 3)) % 2)), c: LEGEND.W })
  }
  return out
}

// ---- 貝殻とヒトデ (波が引いて砂浜に出ている間だけ見える) ----
const STAR = ['..R..', 'RRRRR', '.RRR.', '.R.R.', 'R...R']
const SHELL = ['.PPP.', 'PpPpP', '.PPP.']

function shell(t: number, start: number, seed: number, columns: number, rows: number): Pix[] {
  const local = t - start
  if (local < 0 || local > 50) return []
  const art = hash(seed, 13, 7) < 0.5 ? STAR : SHELL
  const w = art[0].length
  const x = Math.round(2 + (columns - w - 4) * hash(seed, 11, 5))
  const y = Math.min(13 + Math.floor(hash(seed, 10, 4) * 6), rows * 2 - art.length)
  if (swashAt(t, x + w / 2).front > y - 0.5) return [] // 水に隠れている
  return stamp(art, x, y)
}

// ---- 出現の予定 ----
const SLOT = 60 // 秒。この枠ごとに「何が出るか / 出ないか」を決める

// 枠ごとの偶然。出ない枠もある。forced があればその時刻から今すぐ出す (/sea <名前> 用)
export function actorsAt(nowMs: number, columns: number, rows: number, pinned?: number, forced?: ForcedActor): Pix[] {
  const t = nowMs / 1000
  let kind: ActorKind | null
  let start: number
  let seed: number
  if (forced) {
    kind = forced.kind
    start = forced.atMs / 1000
    seed = Math.floor(start) & 0x7fffffff
  } else {
    const slot = Math.floor(t / SLOT)
    seed = slot
    start = slot * SLOT + hash(slot, 8, 2) * 6
    const r = hash(slot, 7, 1)
    kind =
      r < 0.16
        ? 'walk'
        : r < 0.28
          ? 'swept'
          : r < 0.38
            ? 'turtle'
            : r < 0.47
              ? 'fish'
              : r < 0.56
                ? 'gull'
                : r < 0.64
                  ? 'meteor'
                  : r < 0.73
                    ? 'boat'
                    : r < 0.85
                      ? 'shell'
                      : null
    if (kind === 'meteor') {
      const scene = sceneIndexAt(nowMs, pinned)
      if (scene < 3) kind = null // 流れ星は夜と明け方だけ
      start += 4 + hash(slot, 12, 6) * 30
    }
  }

  switch (kind) {
    case 'walk':
      return walk(t, start, seed, columns, rows)
    case 'swept':
      return swept(t, start, seed, columns, rows)
    case 'turtle':
      return turtle(t, start, seed, columns)
    case 'fish':
      return fish(t, start, seed, columns)
    case 'gull':
      return gull(t, start, seed, columns, rows)
    case 'meteor':
      return meteor(t, start, seed, columns)
    case 'boat':
      return boat(t, start, seed, columns)
    case 'shell':
      return shell(t, start, seed, columns, rows)
    default:
      return []
  }
}
