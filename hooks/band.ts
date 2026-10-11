/**
 * The band above the prompt on surfaces that draw Svg, as a strip of green-phosphor
 * terminal: one image (it never wraps mid-phrase the way a row of Text does) of boxed
 * monospace segments on a black tube, with bloom and scanlines.
 */
import { CRT, GLOW_FILTER, SCANLINES } from './theme'

export type BandModel = {
  branch: string
  isWorktree: boolean
  hasUpstream: boolean
  ahead: number
  behind: number
  dirty: number
  others: { name: string; dirty: number }[]
  /** PR counts from GitHub; null when unknown (no `gh`, offline), and then no segment. */
  prs: { toReview: number; changesRequested: number } | null
}

type Tone = 'green' | 'amber' | 'cyan' | 'red' | 'dim'
const TONE: Record<Tone, string> = { green: CRT.green, amber: CRT.amber, cyan: CRT.cyan, red: CRT.red, dim: CRT.dim }

const H = 26
const BOX_H = 20
const GAP = 8
const PAD = 7
const ICON = 13
/** Advance of one character of the monospace face at 12px. */
const CH = 7.23

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Width of `text` in the monospace face at 12px: every character the same. */
export function textWidth(text: string): number {
  return Math.ceil([...text].length * CH)
}

export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  const d = n % 10
  const t = n % 100
  return d >= 2 && d <= 4 && (t < 10 || t >= 20) ? few : many
}

const GITHUB_PATH =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z'

/** A fork glyph: two branches meeting, in the segment's colour. */
const forkIcon = (x: number, y: number, color: string) =>
  `<g transform="translate(${x} ${y}) scale(${ICON / 14})" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="square">` +
  `<rect x="2.3" y="1.3" width="3.4" height="3.4"/><rect x="2.3" y="9.3" width="3.4" height="3.4"/><rect x="8.8" y="2.8" width="3.4" height="3.4"/>` +
  `<path d="M4 4.7v4.6M10.5 6.2v1.6c0 1.2-1 1.6-2.2 1.6H5.7"/></g>`

/** A pull-request glyph: a branch line and a second line returning into it. */
const prIcon = (x: number, y: number, color: string) =>
  `<g transform="translate(${x} ${y}) scale(${ICON / 14})" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter">` +
  `<rect x="1.8" y="1.3" width="3.4" height="3.4"/><rect x="1.8" y="9.3" width="3.4" height="3.4"/><path d="M3.5 4.7v4.6"/>` +
  `<rect x="8.8" y="9.3" width="3.4" height="3.4"/><path d="M10.5 9.3V5.6c0-1-.6-1.7-1.7-1.7H6.4"/><path d="M8 2.2 6.3 3.9 8 5.6"/></g>`

type Part = { text: string; tone?: Tone }
type Seg = { tone: Tone; parts: Part[]; icon?: 'github' | 'fork' | 'pr'; inverse?: boolean }

const upper = (s: string) => s.toLocaleUpperCase('pl-PL')

function segments(m: BandModel): Seg[] {
  const out: Seg[] = []
  // in step with its remote, the branch goes inverse video instead of a segment of its own
  const synced = m.hasUpstream && m.ahead === 0 && m.behind === 0
  out.push({
    tone: 'green',
    icon: 'github',
    inverse: synced,
    parts: [{ text: m.branch }, ...(m.isWorktree ? [{ text: ' WORKTREE', tone: 'cyan' as Tone }] : [])],
  })
  if (!m.hasUpstream) out.push({ tone: 'dim', parts: [{ text: 'BRAK ZDALNEJ' }] })
  if (m.ahead > 0) out.push({ tone: 'amber', parts: [{ text: `↑${m.ahead} PUSH` }] })
  if (m.behind > 0) out.push({ tone: 'cyan', parts: [{ text: `↓${m.behind} POBIERZ` }] })
  if (m.dirty > 0) out.push({ tone: 'amber', parts: [{ text: `●${m.dirty} ${upper(plural(m.dirty, 'zmiana', 'zmiany', 'zmian'))}` }] })
  if (m.others.length > 0) {
    const parts: Part[] =
      m.others.length > 4
        ? [{ text: `${m.others.length} WORKTREE` }]
        : m.others.flatMap((w, i) => [...(i > 0 ? [{ text: ' │ ', tone: 'dim' as Tone }] : []), { text: `${w.name}:${w.dirty}` }])
    out.push({ tone: 'amber', icon: 'fork', parts })
  }
  if (m.prs) {
    const { toReview, changesRequested } = m.prs
    out.push({
      tone: changesRequested > 0 ? 'red' : toReview > 0 ? 'cyan' : 'dim',
      icon: 'pr',
      parts: [
        { text: `${toReview} REVIEW`, tone: toReview > 0 ? 'cyan' : 'dim' },
        { text: ' │ ', tone: 'dim' },
        { text: `${changesRequested} POPRAWA`, tone: changesRequested > 0 ? 'red' : 'dim' },
      ],
    })
  }
  return out
}

export function renderBand(m: BandModel): { source: string; width: number; height: number } {
  const body: string[] = []
  let x = 8
  for (const s of segments(m)) {
    const color = TONE[s.tone]
    const iconW = s.icon ? ICON + 6 : 0
    const textW = s.parts.reduce((w, p) => w + textWidth(p.text), 0)
    const w = PAD * 2 + iconW + textW
    const y = (H - BOX_H) / 2
    body.push(
      s.inverse
        ? `<rect x="${x}" y="${y}" width="${w}" height="${BOX_H}" fill="${color}"/>`
        : `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${BOX_H - 1}" fill="none" stroke="${color}" stroke-opacity=".75"/>`,
    )
    const ink = s.inverse ? CRT.bg : color
    let tx = x + PAD
    const iy = (H - ICON) / 2
    if (s.icon === 'github') {
      body.push(`<g transform="translate(${tx} ${iy}) scale(${ICON / 16})"><path fill="${ink}" d="${GITHUB_PATH}"/></g>`)
      tx += iconW
    } else if (s.icon === 'fork') {
      body.push(forkIcon(tx, iy, ink))
      tx += iconW
    } else if (s.icon === 'pr') {
      body.push(prIcon(tx, iy, ink))
      tx += iconW
    }
    const spans = s.parts
      .map(p => `<tspan fill="${s.inverse ? CRT.bg : TONE[p.tone ?? s.tone]}">${esc(upper(p.text))}</tspan>`)
      .join('')
    body.push(`<text x="${tx}" y="${H / 2 + 4.2}" xml:space="preserve">${spans}</text>`)
    x += w + GAP
  }
  const width = Math.ceil(x - GAP + 8)

  return {
    width,
    height: H,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" ` +
      `font-family="${CRT.font}" font-size="12" font-weight="600">` +
      `<defs>${GLOW_FILTER}${SCANLINES}</defs>` +
      `<rect width="${width}" height="${H}" rx="3" fill="${CRT.bg}"/>` +
      `<g filter="url(#glow)">${body.join('')}</g>` +
      `<rect width="${width}" height="${H}" rx="3" fill="url(#scan)"/></svg>`,
  }
}

/**
 * Text in Unicode's bold sans-serif letters (𝗔𝗕𝗖, 𝟭𝟮𝟯): bold in any font, so a surface that
 * draws a Button's text plain still shows it heavy. Letters with diacritics (Ś, Ł, Ą…) stay
 * as they are: those heavy letters have none, and a combining accent on one is dropped by
 * common fonts (Ś would read as S). Anything else passes unchanged.
 */
export function boldSans(text: string): string {
  return [...text.normalize('NFC')]
    .map(ch => {
      const c = ch.codePointAt(0) ?? 0
      if (c >= 0x41 && c <= 0x5a) return String.fromCodePoint(0x1d5d4 + c - 0x41)
      if (c >= 0x61 && c <= 0x7a) return String.fromCodePoint(0x1d5ee + c - 0x61)
      if (c >= 0x30 && c <= 0x39) return String.fromCodePoint(0x1d7ec + c - 0x30)
      return ch
    })
    .join('')
}

/** A blinking block cursor, as a terminal waits for input: what leads "Wyjaśnij z Claude". */
export const CURSOR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 14" width="8" height="14">' +
  `<defs>${GLOW_FILTER}</defs>` +
  `<rect x="0.5" y="0.5" width="7" height="13" fill="${CRT.green}" filter="url(#glow)">` +
  '<animate attributeName="opacity" values="1;1;0;0" dur="1.1s" repeatCount="indefinite"/></rect></svg>'

/** The tree button's glyph: a short commit graph on the tube, one branch leaving and rejoining. */
export const TREE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">' +
  `<defs>${GLOW_FILTER}</defs><rect width="18" height="18" rx="2" fill="${CRT.bg}"/>` +
  `<g filter="url(#glow)" fill="none" stroke-width="1.6"><path d="M5 2v14" stroke="${CRT.green}"/>` +
  `<path d="M5 5h3c3 0 5 1.5 5 4.5S11 14 8 14H5" stroke="${CRT.amber}"/>` +
  `<rect x="3.3" y="1.8" width="3.4" height="3.4" fill="${CRT.green}" stroke="none"/>` +
  `<rect x="11.3" y="7.8" width="3.4" height="3.4" fill="${CRT.amber}" stroke="none"/>` +
  `<rect x="3.3" y="12.8" width="3.4" height="3.4" fill="${CRT.green}" stroke="none"/></g></svg>`

/** Terminal status colours: modified amber, added green, deleted red, renamed cyan. */
const MARK: Record<string, string> = { A: CRT.green, M: CRT.amber, D: CRT.red, R: CRT.cyan, C: CRT.cyan, T: CRT.cyan }

/** The status as a terminal mark: its letter between brackets, `[M]`, on the tube. */
export function statusDot(status: string): string {
  const color = MARK[status] ?? CRT.dim
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 16" width="26" height="16">` +
    `<defs>${GLOW_FILTER}</defs><rect width="26" height="16" rx="2" fill="${CRT.bg}"/>` +
    `<text x="13" y="12" text-anchor="middle" font-family="${CRT.font}" font-size="11" font-weight="700" fill="${color}" filter="url(#glow)">[${status.replace(/[^A-Z]/g, '')}]</text>` +
    `</svg>`
  )
}
