/**
 * The band above the prompt on surfaces that draw Svg: one row of rounded pills drawn as
 * a single image, so it never wraps mid-phrase the way a row of Text does. Widths come
 * from a per-character estimate of the system font at 12px.
 */

export type BandModel = {
  branch: string
  isWorktree: boolean
  hasUpstream: boolean
  ahead: number
  behind: number
  dirty: number
  others: { name: string; dirty: number }[]
  /** PR counts from GitHub; null when unknown (no `gh`, offline), and then no pill. */
  prs: { toReview: number; changesRequested: number } | null
}

type Tone = 'green' | 'amber' | 'blue' | 'gray' | 'purple' | 'red' | 'plain'

// text on a tint of the same hue: bright in dark mode, deep in light mode
const TONES: Record<Tone, { light: string; dark: string }> = {
  green: { light: '#1A7F37', dark: '#3FB950' },
  amber: { light: '#9A6700', dark: '#D29922' },
  blue: { light: '#0969DA', dark: '#58A6FF' },
  purple: { light: '#8250DF', dark: '#A371F7' },
  red: { light: '#CF222E', dark: '#F85149' },
  gray: { light: '#6E7781', dark: '#8B949E' },
  plain: { light: '#1F2328', dark: '#E6EDF3' },
}

const H = 26
const PILL_H = 22
const GAP = 6
const PAD = 9
const ICON = 14

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Rough width of `text` at 12px in the system UI font: narrow, wide and digit glyphs apart. */
export function textWidth(text: string, bold = false): number {
  let w = 0
  for (const ch of text) {
    if ('iljtf.,:;·|!\'"'.includes(ch)) w += 3.6
    else if ('mwMW@'.includes(ch)) w += 10.2
    else if (/[A-Z]/.test(ch)) w += 8
    else if (/[0-9]/.test(ch)) w += 7
    else if (ch === ' ') w += 3.4
    else w += 6.6
  }
  return Math.ceil(w * (bold ? 1.06 : 1))
}

export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  const d = n % 10
  const t = n % 100
  return d >= 2 && d <= 4 && (t < 10 || t >= 20) ? few : many
}

const GITHUB_PATH =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z'

/** A 14px fork glyph: two branches meeting, drawn in the pill's colour. */
const forkIcon = (x: number, y: number, cls: string) =>
  `<g transform="translate(${x} ${y})" class="${cls}" fill="none" stroke-width="1.6" stroke-linecap="round">` +
  `<circle cx="4" cy="3" r="1.8"/><circle cx="4" cy="11" r="1.8"/><circle cx="10.5" cy="4.5" r="1.8"/>` +
  `<path d="M4 4.8v4.4M10.5 6.3c0 2.4-2.2 3-6.1 3.4"/></g>`

/** A 14px pull-request glyph: a branch line and a second line curving back into it. */
const prIcon = (x: number, y: number, cls: string) =>
  `<g transform="translate(${x} ${y})" class="${cls}" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
  `<circle cx="3.5" cy="3" r="1.8"/><circle cx="3.5" cy="11" r="1.8"/><path d="M3.5 4.8v4.4"/>` +
  `<circle cx="10.5" cy="11" r="1.8"/><path d="M10.5 9.2V5.6c0-1-.6-1.7-1.7-1.7H6.4"/><path d="M8 2.2 6.3 3.9 8 5.6"/></g>`

type Pill = { tone: Tone; parts: { text: string; tone?: Tone; bold?: boolean }[]; icon?: 'github' | 'fork' | 'pr' }

function pills(m: BandModel): Pill[] {
  const out: Pill[] = []
  // in step with its remote, the branch pill itself turns green instead of a pill of its own
  const synced = m.hasUpstream && m.ahead === 0 && m.behind === 0
  out.push({
    tone: synced ? 'green' : 'plain',
    icon: 'github',
    parts: [{ text: m.branch, bold: true }, ...(m.isWorktree ? [{ text: '  worktree', tone: 'purple' as Tone }] : [])],
  })
  if (!m.hasUpstream) out.push({ tone: 'gray', parts: [{ text: 'brak gałęzi zdalnej' }] })
  if (m.ahead > 0) out.push({ tone: 'amber', parts: [{ text: `↑ ${m.ahead} do push`, bold: true }] })
  if (m.behind > 0) out.push({ tone: 'blue', parts: [{ text: `↓ ${m.behind} do pobrania`, bold: true }] })
  if (m.dirty > 0) {
    out.push({ tone: 'amber', parts: [{ text: `● ${m.dirty} ${plural(m.dirty, 'zmiana', 'zmiany', 'zmian')}`, bold: true }] })
  }
  if (m.others.length > 0) {
    const parts: Pill['parts'] =
      m.others.length > 4
        ? [{ text: `${m.others.length} worktree ze zmianami`, bold: true }]
        : m.others.flatMap((w, i) => [
            ...(i > 0 ? [{ text: '  ·  ', tone: 'gray' as Tone }] : []),
            { text: w.name, bold: true },
            { text: ` ${w.dirty}` },
          ])
    out.push({ tone: 'amber', icon: 'fork', parts })
  }
  if (m.prs) {
    const { toReview, changesRequested } = m.prs
    const reviewTone: Tone = toReview > 0 ? 'blue' : 'gray'
    const backTone: Tone = changesRequested > 0 ? 'red' : 'gray'
    out.push({
      tone: changesRequested > 0 ? 'red' : toReview > 0 ? 'blue' : 'gray',
      icon: 'pr',
      parts: [
        { text: `${toReview} do review`, tone: reviewTone, bold: toReview > 0 },
        { text: '  ·  ', tone: 'gray' },
        { text: `${changesRequested} do poprawy`, tone: backTone, bold: changesRequested > 0 },
      ],
    })
  }
  return out
}

export function renderBand(m: BandModel): { source: string; width: number; height: number } {
  const body: string[] = []
  let x = 0
  for (const p of pills(m)) {
    const iconW = p.icon ? ICON + 6 : 0
    const textW = p.parts.reduce((w, part) => w + textWidth(part.text, part.bold), 0)
    const w = PAD * 2 + iconW + textW
    const y = (H - PILL_H) / 2
    body.push(`<rect class="bg-${p.tone}" x="${x}" y="${y}" width="${w}" height="${PILL_H}" rx="${PILL_H / 2}"/>`)
    let tx = x + PAD
    if (p.icon === 'github') {
      body.push(`<g transform="translate(${tx} ${(H - ICON) / 2}) scale(${ICON / 16})"><path class="fg-${p.tone}" d="${GITHUB_PATH}"/></g>`)
      tx += iconW
    } else if (p.icon === 'fork') {
      body.push(forkIcon(tx, (H - ICON) / 2, `st-${p.tone}`))
      tx += iconW
    } else if (p.icon === 'pr') {
      body.push(prIcon(tx, (H - ICON) / 2, `st-${p.tone}`))
      tx += iconW
    }
    let spans = ''
    for (const part of p.parts) {
      spans += `<tspan class="fg-${part.tone ?? p.tone}"${part.bold ? ' font-weight="600"' : ''}>${esc(part.text)}</tspan>`
    }
    body.push(`<text x="${tx}" y="${H / 2 + 4.2}" xml:space="preserve">${spans}</text>`)
    x += w + GAP
  }
  const width = Math.max(1, Math.ceil(x - GAP))

  const css = (mode: 'light' | 'dark') =>
    (Object.keys(TONES) as Tone[])
      .map(t => {
        const c = TONES[t][mode]
        return `.fg-${t}{fill:${c}}.st-${t}{stroke:${c}}.bg-${t}{fill:${c};fill-opacity:${mode === 'dark' ? 0.16 : 0.1}}`
      })
      .join('')

  return {
    width,
    height: H,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" ` +
      `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12">` +
      `<style>${css('light')}@media (prefers-color-scheme:dark){${css('dark')}}</style>` +
      `${body.join('')}</svg>`,
  }
}

/** The tree button's glyph: a short commit graph, one branch leaving and rejoining the main line. */
export const TREE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18" fill="none" stroke-width="1.8" stroke-linecap="round">' +
  '<path d="M5 2v14" stroke="#A371F7"/><path d="M5 5c0 2.5 8 1.5 8 4.5S5 11.5 5 14" stroke="#3FB950"/>' +
  '<circle cx="5" cy="3" r="2" fill="#A371F7"/><circle cx="13" cy="9" r="2" fill="#3FB950"/><circle cx="5" cy="15" r="2" fill="#A371F7"/>' +
  '</svg>'
