// 海の描画 (純粋関数)。端末にもエンジンにも依存しない。
// 絵は「ドット」の格子 (幅 w × 高さ h) に role 番号 (0..21) を塗って作り、
// 端末 (Raster) とデスクトップ (Svg) のどちらにも同じ絵を渡す。
// 端末では 1 ドット = 横 2 桁 × 縦 1 行 (ほぼ正方形)。色は 22 色に量子化するので Raster の色数上限に収まる。

export type Rgb = [number, number, number]

type Scene = {
  label: string
  deep: Rgb
  mid: Rgb
  shallow: Rgb
  foam: [Rgb, Rgb, Rgb]
  wet: Rgb
  dry: Rgb
  glint: [Rgb, Rgb, Rgb]
  glintX: number // きらめきの中心 (0..1, 横位置)
  glintPower: number // きらめきの強さ (0..1)
}

const hex = (s: string): Rgb => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
]

// 朝 → 昼 → 夕焼け → 夜 → 明け方 の順に巡る
export const SCENES: Scene[] = [
  {
    label: '朝の海',
    deep: hex('#0a3a78'),
    mid: hex('#2a86c8'),
    shallow: hex('#8fe0ec'),
    foam: [hex('#cfeeff'), hex('#f2fbff'), hex('#ffffff')],
    wet: hex('#b8a58c'),
    dry: hex('#f2e2c0'),
    glint: [hex('#cdeeff'), hex('#fff6d0'), hex('#ffffff')],
    glintX: 0.28,
    glintPower: 0.7,
  },
  {
    label: 'エメラルドの海',
    deep: hex('#035e5c'),
    mid: hex('#10b08e'),
    shallow: hex('#8af5c8'),
    foam: [hex('#d6fff0'), hex('#f0fffa'), hex('#ffffff')],
    wet: hex('#cdb882'),
    dry: hex('#f8ecc0'),
    glint: [hex('#d8fff2'), hex('#ffffe0'), hex('#ffffff')],
    glintX: 0.5,
    glintPower: 0.5,
  },
  {
    label: '夕焼けの海',
    deep: hex('#4a1238'),
    mid: hex('#c4403c'),
    shallow: hex('#ff9c5c'),
    foam: [hex('#ffd2b4'), hex('#ffe9d6'), hex('#fff7ee')],
    wet: hex('#7c3a34'),
    dry: hex('#e9a272'),
    glint: [hex('#ffd27a'), hex('#ffe9a8'), hex('#fffbe0')],
    glintX: 0.72,
    glintPower: 0.9,
  },
  {
    label: '真夜中の海',
    deep: hex('#010310'),
    mid: hex('#0a1d4c'),
    shallow: hex('#2c5c9a'),
    foam: [hex('#7da6d8'), hex('#bcd4ee'), hex('#eef4ff')],
    wet: hex('#141b2a'),
    dry: hex('#3d475c'),
    glint: [hex('#c9d8f5'), hex('#fff7d8'), hex('#ffffff')],
    glintX: 0.62,
    glintPower: 1,
  },
  {
    label: '明け方の海',
    deep: hex('#1b1f55'),
    mid: hex('#7a5cae'),
    shallow: hex('#f4a6bc'),
    foam: [hex('#f8d4e4'), hex('#fdeef4'), hex('#ffffff')],
    wet: hex('#5f4a6c'),
    dry: hex('#e6bfb4'),
    glint: [hex('#ffd6e8'), hex('#fff0f6'), hex('#ffffff')],
    glintX: 0.4,
    glintPower: 0.6,
  },
]

// 1 シーンの表示秒数 (最後の 30% で次のシーンへクロスフェード)
export const SCENE_SECONDS = 96 // 5 場面で 480 秒 = 波の予定表 (96 秒) のちょうど 5 周。音の 480 秒ループと合わせる
const FADE_START = 0.7

// role の並び: 水 0..9 (沖→浅瀬) / 泡 10..12 / 砂 13..18 (濡れ→乾き) / きらめき 19..21
const W = 0
const F = 10
const S = 13
const G = 19
const ROLES = 22

const lerp = (a: number, b: number, m: number) => a + (b - a) * m
const lerpRgb = (a: Rgb, b: Rgb, m: number): Rgb => [lerp(a[0], b[0], m), lerp(a[1], b[1], m), lerp(a[2], b[2], m)]
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const frac = (v: number) => v - Math.floor(v)
const smooth = (v: number) => {
  const c = clamp(v, 0, 1)
  return c * c * (3 - 2 * c)
}

function rolesOf(s: Scene): Rgb[] {
  const out: Rgb[] = []
  for (let i = 0; i < 10; i++) {
    const u = i / 9
    out.push(u < 0.5 ? lerpRgb(s.deep, s.mid, u * 2) : lerpRgb(s.mid, s.shallow, (u - 0.5) * 2))
  }
  out.push(...s.foam)
  for (let j = 0; j < 6; j++) out.push(lerpRgb(s.wet, s.dry, j / 5))
  out.push(...s.glint)
  return out
}

// ---- 波打ち際 (海と、波にさらわれる Claude くんと、波の音の全部が同じ予定表を使う) ----
// 単位は「高さ 24」の仮想座標 (端末 12 行 = 半行 24)。y は大きいほど手前 (砂浜側)。
// 波は 1 つずつ別物: 来る間隔・大きさ・寄せる速さ・引く長さがばらつく。
// 予定表は LOOP 秒で一巡する (96 秒に 16 波)。一巡しても人間には周期と分からない長さにしてある
export const LOOP = 96
const WAVE_COUNT = 16
const REACH = 12 // 波が引いた位置から寄せる最大の距離 (仮想座標)

export type Wave = {
  t: number // 寄せ始める時刻 (LOOP 内の秒。格子点 6 秒おきからずらす)
  amp: number // 大きさ。0.35 (小さな波) ～ 1.1 (大きな波)
  rush: number // 寄せる秒数
  drain: number // 引く秒数
  skew: number // 左右の到着差 (秒/桁)。波ごとに斜めに来る向きが違う
}

export const WAVES: Wave[] = Array.from({ length: WAVE_COUNT }, (_, k) => ({
  t: k * 6 + (hash(k, 1, 77) - 0.5) * 5,
  amp: 0.35 + 0.75 * hash(k, 2, 77),
  rush: 1.0 + 0.7 * hash(k, 4, 77),
  drain: 3.2 + 1.6 * hash(k, 5, 77),
  skew: (hash(k, 6, 77) - 0.5) * 0.008,
}))

// 1 つの波の水位 (0..1)。寄せは急加速→減速、頂点でとどまらず引き始める
function lift(tau: number, rush: number, drain: number): number {
  if (tau <= 0) return 0
  if (tau < rush) return 1 - (1 - tau / rush) ** 3
  const r = (tau - rush) / drain
  if (r >= 1) return 0
  const rr = r ** 0.8
  return 1 - rr * rr * (3 - 2 * rr)
}

export type Swash = { front: number; base: number; isRetreating: boolean; rushing: number }

// 潮位: 波が引いたときの汀線の位置。固定せず、数十秒かけてゆっくり出入りする。
// 沖へ引きすぎている時間もあれば、ずっと手前まで水がある時間もある。左右でもうねる。
// 時間変化は LOOP 秒で一巡する周期だけで作る (音も同じ潮位に合わせて変えるため)
function tideTime(t: number): number {
  const w = 2 * Math.PI
  return 3.2 * Math.sin((w * t) / 48 + 0.7) + 2.6 * Math.sin((w * t) / 32 + 2.1) + 1.4 * Math.sin((w * t * 7) / 96 + 4)
}
const squashTide = (offset: number) => 9.25 + 5.75 * Math.tanh(offset / 6.5) // 3.5..15 に滑らかに収める (頭打ちの境目を作らない)

export function tideAt(t: number, vx: number): number {
  return squashTide(tideTime(t) + 1.6 * Math.sin(vx * 0.035 + t * 0.04) + 0.8 * Math.sin(vx * 0.11 - t * 0.07))
}

// 音用: 横のうねりを除いた潮位を 0.5 秒おきに LOOP 秒ぶん
export function tideSeries(): number[] {
  return Array.from({ length: LOOP * 2 }, (_, i) => squashTide(tideTime(i / 2)))
}

// 時刻 t (秒、時計の絶対時刻) に、横位置 vx (仮想座標。端末の桁 ≒ vx) での汀線の位置。
// 重なった波は高いほうをとる (前の波の引き波の上に次の波が乗る)
export function swashAt(t: number, vx: number): Swash {
  const u = ((t % LOOP) + LOOP) % LOOP
  const wob = 0.3 * Math.sin(vx * 0.075 + t * 0.21) + 0.12 * Math.sin(vx * 0.21 - t * 0.33)
  let best = 0
  let bestTau = -1
  let bestRush = 1
  for (const w of WAVES) {
    for (let s = -LOOP; s <= LOOP; s += LOOP) {
      const tau = u - (w.t + s) - w.skew * vx - wob
      if (tau < 0 || tau > w.rush + w.drain) continue
      const v = w.amp * lift(tau, w.rush, w.drain)
      if (v > best) {
        best = v
        bestTau = tau
        bestRush = w.rush
      }
    }
  }
  const amp = 0.92 + 0.08 * Math.sin(vx * 0.045 + t * 0.07 + 1) + 0.04 * Math.sin(vx * 0.17)
  // 静かなときも縁が止まらない小さなさざ波
  const ripple = 0.55 * Math.sin((2 * Math.PI * t) / 2.4 + vx * 0.06) + 0.35 * Math.sin((2 * Math.PI * t) / 1.7 - vx * 0.13 + 1)
  const base = tideAt(t, vx)
  return {
    front: Math.min(24.5, base + REACH * best * amp + ripple),
    base,
    isRetreating: bestTau > bestRush,
    rushing: bestTau >= 0 && bestTau < bestRush * 1.8 ? 1 - bestTau / (bestRush * 1.8) : 0, // 寄せている間は泡を厚くする
  }
}

// tAbs (秒) より後に寄せ始める、amp が minAmp 以上の波の時刻 (絶対時刻の秒)
export function nextSurgeAfter(tAbs: number, minAmp: number): number {
  const base = Math.floor(tAbs / LOOP) * LOOP
  let best = Infinity
  for (let n = -1; n <= 2; n++) {
    for (const w of WAVES) {
      const at = base + n * LOOP + w.t
      if (w.amp >= minAmp && at > tAbs && at < best) best = at
    }
  }
  return best
}

// 今の場面の添字 (クロスフェード中は進む先)。流れ星を夜にだけ出すのに使う
export function sceneIndexAt(nowMs: number, pinned?: number): number {
  if (pinned !== undefined) return clamp(pinned, 0, SCENES.length - 1)
  const pos = (nowMs / 1000 / SCENE_SECONDS) % SCENES.length
  const a = Math.floor(pos)
  return smooth((frac(pos) - FADE_START) / (1 - FADE_START)) > 0.5 ? (a + 1) % SCENES.length : a
}

// 整数座標の疑似乱数 (0..1)
export function hash(x: number, y: number, k: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(k, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export type Paint = {
  width: number
  height: number
  px: Uint8Array // role 番号 (height 行 × width 列)
  rgb: Uint32Array // role → 0x00RRGGBB
  label: string
}

// pinned: 0..SCENES.length-1 で固定。undefined なら時間経過で自動ループ
export function paintSea(width: number, height: number, nowMs: number, pinned?: number): Paint {
  const t = nowMs / 1000
  const n = SCENES.length

  // シーン選択とクロスフェード
  let a = 0
  let b = 0
  let m = 0
  if (pinned === undefined) {
    const pos = (t / SCENE_SECONDS) % n
    a = Math.floor(pos)
    b = (a + 1) % n
    m = smooth((frac(pos) - FADE_START) / (1 - FADE_START))
  } else {
    a = b = clamp(pinned, 0, n - 1)
  }
  const sa = SCENES[a]
  const sb = SCENES[b]
  const ra = rolesOf(sa)
  const rb = rolesOf(sb)
  const rgb = new Uint32Array(ROLES)
  for (let i = 0; i < ROLES; i++) {
    const c = lerpRgb(ra[i], rb[i], m)
    rgb[i] = (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])
  }
  const glintX = lerp(sa.glintX, sb.glintX, m)
  const glintPower = lerp(sa.glintPower, sb.glintPower, m)
  const label = m > 0.5 ? sb.label : sa.label

  // 計算は「高さ 24・1 ドット = 横 2」の仮想座標 (vx, vy) で行い、ドットの中心で標本化する
  const VH = 24
  const vScale = VH / height
  const px = new Uint8Array(width * height)
  // 波筋の進み: 速さがゆっくり揺らぐ (一定速度だと機械的に見える)
  const crestPhase = 0.42 * t + 0.8 * Math.sin(t * 0.12) + 0.4 * Math.sin(t * 0.047 + 2)
  const tick = Math.floor(t * 2.5)
  const tickSlow = Math.floor(t * 1.5)

  for (let x = 0; x < width; x++) {
    const vx = (x + 0.5) * 2

    const sw = swashAt(t, vx)
    const front = sw.front
    const retreating = sw.isRetreating
    const rushing = sw.rushing

    // 沖から寄せてくる波筋 (列ごとの横ゆらぎ)
    const sway = 0.55 * Math.sin(vx * 0.065 + t * 0.3) + 0.25 * Math.sin(vx * 0.18 - t * 0.45)
    const prox = Math.exp(-((x / width - glintX) ** 2) / (2 * 0.12 * 0.12))

    for (let y = 0; y < height; y++) {
      const vy = (y + 0.5) * vScale
      let role: number
      if (vy < front) {
        const d = front - vy
        let idx = 9 - Math.min(9, Math.floor(d * 0.6))
        // 波筋: 手前ほど間隔が広く太い (遠近)。岸へ向かって進む
        const depth = vy / VH
        const band = frac(3 * (1 - (1 - depth) ** 1.8) - crestPhase + sway)
        let crest = false
        if (d < 20) {
          if (band < 0.22 + 0.2 * depth) crest = true
          else if (band > 0.8) idx -= 1
        }
        role = W + clamp(idx, 0, 9)
        if (crest) role = d < 9 ? F : W + clamp(idx + 3, 0, 9)
        const foam1 = 1.5 + 2.5 * rushing
        const foam2 = 3.2 + 3.5 * rushing
        if (d < foam1) role = F + 2
        else if (d < foam2) role = F + 1
        else if (d < foam2 + 3.3 && hash(x, y, tickSlow) < 0.3 * (1 - (d - foam2) / 3.3)) role = F
        else if (d > 4 && !crest && hash(x, y, tick) < 0.1 * glintPower * prox) {
          const r2 = hash(y, x, tick)
          role = G + (r2 < 0.55 ? 0 : r2 < 0.9 ? 1 : 2)
        }
      } else {
        const s = vy - front
        if (retreating && s < 2) {
          role = F // 引き波の薄い水膜
        } else {
          const dryness = clamp(0.65 * (s / (VH * 0.25)) + 0.35 * ((vy - sw.base) / (VH - sw.base)), 0, 1)
          role = S + Math.round(dryness * 5)
        }
      }
      px[y * width + x] = role
    }
  }

  return { width, height, px, rgb, label }
}

// ---- 動くもの (actors.ts) を重ねて描く ----
// 座標は「細かいドット」: 横 1 桁 = 1、縦は半行 = 1 (端末の 1 行 = 2)。海のドットは横 2 × 縦 2 に当たる。
// 色は 0x00RRGGBB。SHADE + n は「下の色を n% 暗くする」(影)
export const SHADE = 0x2000000
export type Pix = { x: number; y: number; c: number }

const darken = (rgb: number, pct: number) => {
  const k = 1 - pct / 100
  return (Math.round(((rgb >> 16) & 255) * k) << 16) | (Math.round(((rgb >> 8) & 255) * k) << 8) | Math.round((rgb & 255) * k)
}

// 端末用: 1 ドット = 横 2 桁 × 縦 1 行。重ねるものがある半行だけ ▀ で細かく塗る。Raster の cells (base64)
export function toCells(paint: Paint, columns: number, overlay?: readonly Pix[] | null): string {
  const { width, height, px, rgb } = paint
  const half = new Int32Array(columns * height * 2).fill(-1) // 半行ごとの重ね色
  if (overlay) {
    for (const o of overlay) {
      if (o.x >= 0 && o.x < columns && o.y >= 0 && o.y < height * 2) half[o.y * columns + o.x] = o.c
    }
  }
  const words = new Uint32Array(columns * height * 3)
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      const sea = rgb[px[cy * width + Math.min(width - 1, cx >> 1)]]
      const top = half[cy * 2 * columns + cx]
      const bottom = half[(cy * 2 + 1) * columns + cx]
      const o = (cy * columns + cx) * 3
      if (top < 0 && bottom < 0) {
        words[o] = 0x2588
        words[o + 1] = sea
        words[o + 2] = sea
      } else {
        words[o] = 0x2580
        words[o + 1] = top < 0 ? sea : top >= SHADE ? darken(sea, top - SHADE) : top
        words[o + 2] = bottom < 0 ? sea : bottom >= SHADE ? darken(sea, bottom - SHADE) : bottom
      }
    }
  }
  const bytes = new Uint8Array(words.buffer) as Uint8Array & { toBase64(): string }
  return bytes.toBase64()
}

const css = (c: number) => '#' + (c | 0x1000000).toString(16).slice(1)

// デスクトップ用: 同じ色の横並びをまとめた rect の SVG。重ねるものは 0.5 単位の細かい rect。
// overlay の桁は「海のドット幅 × 2」を前提にする (columns = paint.width * 2)
export function toSvg(paint: Paint, dotPx: number, overlay?: readonly Pix[] | null): string {
  const { width, height, px, rgb } = paint
  const rects: string[] = []
  for (let y = 0; y < height; y++) {
    let x = 0
    while (x < width) {
      const role = px[y * width + x]
      let end = x + 1
      while (end < width && px[y * width + end] === role) end++
      rects.push(`<rect x="${x}" y="${y}" width="${end - x + 0.03}" height="1.03" fill="${css(rgb[role])}"/>`)
      x = end
    }
  }
  if (overlay) {
    for (const o of overlay) {
      if (o.x < 0 || o.x >= width * 2 || o.y < 0 || o.y >= height * 2) continue
      const at = `x="${o.x * 0.5}" y="${o.y * 0.5}" width="0.53" height="0.53"`
      rects.push(
        o.c >= SHADE
          ? `<rect ${at} fill="#000" fill-opacity="${(o.c - SHADE) / 100}"/>`
          : `<rect ${at} fill="${css(o.c)}"/>`,
      )
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width * dotPx}" ` +
    `height="${height * dotPx}" shape-rendering="crispEdges">${rects.join('')}</svg>`
  )
}
