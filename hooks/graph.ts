import type { Commit } from '../types'

export type Row = { lane: number; through: number[]; isMerge: boolean }
export type Edge = {
  fromRow: number
  toRow: number | null
  fromLane: number
  viaLane: number
  toLane: number
}
export type Layout = { rows: Row[]; edges: Edge[]; lanes: number }

export const SEP = '\x1f'

export function parseLog(stdout: string): Commit[] {
  return stdout
    .split('\n')
    .filter(line => line.includes(SEP))
    .map(line => {
      const [hash = '', parents = '', refs = '', ts = '0', author = '', subject = ''] = line.split(SEP)
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        refs: refs ? refs.split(', ').filter(r => r !== 'origin/HEAD') : [],
        ts: Number(ts) * 1000,
        author,
        subject,
      }
    })
}

/** Lanes the classic way: each lane waits for one hash; a commit lands in the first lane waiting for it. */
export function layout(commits: Commit[]): Layout {
  const lanes: (string | null)[] = []
  const rowOf = new Map(commits.map((c, i) => [c.hash, i]))
  const rows: Row[] = []
  const pending: { fromRow: number; fromLane: number; viaLane: number; parent: string }[] = []

  const slot = (hash: string) => {
    const free = lanes.indexOf(null)
    if (free === -1) {
      lanes.push(hash)
      return lanes.length - 1
    }
    lanes[free] = hash
    return free
  }

  commits.forEach((c, r) => {
    let lane = lanes.indexOf(c.hash)
    const through = lanes.flatMap((h, i) => (h !== null && h !== c.hash ? [i] : []))
    lanes.forEach((h, i) => {
      if (h === c.hash) lanes[i] = null
    })
    if (lane === -1) lane = slot(c.hash)
    lanes[lane] = null

    c.parents.forEach((p, i) => {
      // The first parent keeps this lane even when another lane already waits for it:
      // both converge on the parent, which lands in the leftmost of them.
      let via: number
      if (i === 0) {
        lanes[lane] = p
        via = lane
      } else {
        via = lanes.indexOf(p)
        if (via === -1) via = slot(p)
      }
      pending.push({ fromRow: r, fromLane: lane, viaLane: via, parent: p })
    })
    rows.push({ lane, through, isMerge: c.parents.length > 1 })
  })

  const edges = pending.map(e => {
    const toRow = rowOf.get(e.parent) ?? null
    return {
      fromRow: e.fromRow,
      toRow,
      fromLane: e.fromLane,
      viaLane: e.viaLane,
      toLane: toRow === null ? e.viaLane : (rows[toRow]?.lane ?? e.viaLane),
    }
  })

  return { rows, edges, lanes: Math.max(1, lanes.length) }
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'teraz'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} godz.`
  const d = Math.round(h / 24)
  if (d < 31) return d === 1 ? '1 dzień' : `${d} dni`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo} mies.`
  return `${Math.round(mo / 12)} l.`
}

const LANE_COLORS = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#D4537E', '#BA7517', '#639922', '#888780']
const color = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length] ?? '#888780'

export type RefKind = 'head' | 'local' | 'remote' | 'tag'

export function refChips(refs: string[]): { label: string; kind: RefKind }[] {
  return refs.map(ref => {
    if (ref.startsWith('HEAD -> ')) return { label: `◆ ${ref.slice(8)}`, kind: 'head' as const }
    if (ref === 'HEAD') return { label: '◆ HEAD', kind: 'head' as const }
    if (ref.startsWith('tag: ')) return { label: ref.slice(5), kind: 'tag' as const }
    if (/^[^/]+\//.test(ref) && ref.startsWith('origin/')) return { label: ref, kind: 'remote' as const }
    return { label: ref, kind: 'local' as const }
  })
}

/** Height of one commit row in pixels: the lanes image and the row buttons beside it share it. */
export const ROW_H = 28
const LANE_W = 14
const PAD = 10

/** One drawn shape and the vertical span it covers, so a window keeps only what crosses it. */
type LaneItem = { top: number; bottom: number; svg: string }
export type Lanes = { items: LaneItem[]; width: number; rows: number }

/**
 * The graph's lines and dots alone, row `r` filling y = r·ROW_H … (r+1)·ROW_H, with no
 * text: each row's text is a real button beside it. Desktop draws one `laneWindow`
 * per row beside that row's button, so the image, not a box size, sets the row height.
 */
export function renderLanes(commits: Commit[]): Lanes {
  const { rows, edges, lanes } = layout(commits)
  const H = rows.length * ROW_H
  const x = (lane: number) => PAD + lane * LANE_W
  const y = (row: number) => row * ROW_H + ROW_H / 2
  const items: LaneItem[] = []
  const out = { push: (svg: string, top: number, bottom: number) => items.push({ top, bottom, svg }) }

  for (const e of edges) {
    const xa = x(e.fromLane)
    const xk = x(e.viaLane)
    const ya = y(e.fromRow)
    const c = color(e.viaLane)
    let d: string
    if (e.toRow === null) {
      const yEnd = H
      d =
        xk === xa
          ? `M${xa} ${ya}V${yEnd}`
          : `M${xa} ${ya}C${xa} ${ya + ROW_H / 2} ${xk} ${ya + ROW_H / 2} ${xk} ${ya + ROW_H}V${yEnd}`
      out.push(`<path class="e o" d="${d}" stroke="${c}"/>`, ya, yEnd)
      continue
    }
    const xb = x(e.toLane)
    const yb = y(e.toRow)
    const curve = (x1: number, y1: number, x2: number, y2: number) =>
      x1 === x2 ? `V${y2}` : `C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`
    if (e.toRow === e.fromRow + 1) {
      d = `M${xa} ${ya}${curve(xa, ya, xb, yb)}`
    } else if (xk === xa) {
      d = `M${xa} ${ya}V${yb - ROW_H}${curve(xk, yb - ROW_H, xb, yb)}`
    } else {
      d = `M${xa} ${ya}${curve(xa, ya, xk, ya + ROW_H)}V${yb - ROW_H}${curve(xk, yb - ROW_H, xb, yb)}`
    }
    out.push(`<path class="e" d="${d}" stroke="${c}"/>`, ya, yb)
  }

  commits.forEach((c, r) => {
    const row = rows[r]
    if (!row) return
    const cx = x(row.lane)
    const cy = y(r)
    const col = color(row.lane)
    if (c.refs.some(ref => ref.startsWith('HEAD'))) {
      out.push(`<circle cx="${cx}" cy="${cy}" r="8" fill="none" stroke="${col}" stroke-width="1.5"/>`, cy - 8, cy + 8)
    }
    out.push(
      row.isMerge
        ? `<circle class="bg" cx="${cx}" cy="${cy}" r="4.5" stroke="${col}" stroke-width="2"/>`
        : `<circle cx="${cx}" cy="${cy}" r="5" fill="${col}"/>`,
      cy - 5,
      cy + 5,
    )
  })

  return { items, width: PAD * 2 + (lanes - 1) * LANE_W, rows: rows.length }
}

/**
 * Rows `from` (inclusive) to `to` (exclusive) of the lanes as a standalone SVG of their
 * height, holding only the shapes that cross them; lines cut at the edge meet the next
 * window's, so stacked windows read as one graph.
 */
export function laneWindow(l: Lanes, from: number, to: number): { source: string; height: number } {
  const top = from * ROW_H
  const height = Math.max(0, to - from) * ROW_H
  const inner = l.items
    .filter(item => item.bottom >= top && item.top <= top + height)
    .map(item => item.svg)
    .join('')
  return {
    height,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${top} ${l.width} ${height}" width="${l.width}" height="${height}">` +
      `<style>.e{fill:none;stroke-width:2}.o{stroke-dasharray:3 3;opacity:.7}.bg{fill:#fff}@media (prefers-color-scheme:dark){.bg{fill:#262624}}</style>` +
      `${inner}</svg>`,
  }
}

/** The terminal's fallback: one text line per commit, lanes as │ and ●. */
export function asciiRows(commits: Commit[]): string[] {
  const { rows, lanes } = layout(commits)
  return rows.map(row => {
    let s = ''
    for (let l = 0; l < lanes; l++) {
      s += l === row.lane ? (row.isMerge ? '◉' : '●') : row.through.includes(l) ? '│' : ' '
      s += ' '
    }
    return s
  })
}
