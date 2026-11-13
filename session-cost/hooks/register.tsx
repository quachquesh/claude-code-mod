import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AgentGroup,
  AgentRow,
  AgentStep,
  Calibration,
  ChartMode,
  ContextFill,
  Ledger,
  Live,
  ModelRow,
  RateKind,
  Reading,
  Tab,
  Tokens,
  TurnAgentRow,
  TurnRow,
  UsageLedger,
} from '../types'
import {
  KEEP_MS,
  addSpend,
  dayBars,
  factor,
  hourBars,
  learn,
  mergeSpend,
  pruneSpend,
  qualifies,
  share,
  spendBetween,
  windowStart,
} from './usage'

const PANE = 'session-cost'
const TITLE = 'Session cost'
const MAX_TURNS = 60

const EMPTY: Ledger = {
  models: {},
  webSearches: 0,
  webFetches: 0,
  serverTools: {},
  subagentRequests: 0,
  turns: [],
  turnCount: 0,
}

// Change the tag when Ledger's fields change: it declines what an earlier
// version stored, which outlives a reload.
const ledger = atom({ plugin: 'session-cost', key: 'ledger' } as const, EMPTY, {
  shape: 'ledger-2',
})
const total = atom({ plugin: 'session-cost', key: 'total' } as const, null)
const tab = atom({ plugin: 'session-cost', key: 'tab' } as const, 'summary' as Tab)

const EMPTY_LIVE: Live = {
  turnStartedAt: null,
  turnEndedAt: null,
  isRunning: false,
  streamingSince: null,
  lastTps: null,
  liveTps: null,
  turnOutput: 0,
  turnGenMs: 0,
  lastResponseAt: null,
}
const live = atom({ plugin: 'session-cost', key: 'live' } as const, EMPTY_LIVE, { shape: 'live-2' })
const contextFill = atom({ plugin: 'session-cost', key: 'context' } as const, null as ContextFill | null)
const chartMode = atom({ plugin: 'session-cost', key: 'chartMode' } as const, 'source' as ChartMode)
const selectedTurn = atom({ plugin: 'session-cost', key: 'selectedTurn' } as const, null as number | null)
const agentCosts = atom({ plugin: 'session-cost', key: 'agents' } as const, {} as Record<string, AgentRow>, {
  shape: 'agents-2',
})
const selectedAgent = atom({ plugin: 'session-cost', key: 'selectedAgent' } as const, null as string | null)
const folded = atom({ plugin: 'session-cost', key: 'folded' } as const, {} as Partial<Record<AgentGroup, boolean>>)
const startedAt = atom({ plugin: 'session-cost', key: 'startedAt' } as const, null as number | null)
const MAX_STEPS = 80
// The main thread's prompt cache is taken to live an hour after its last response.
const CACHE_TTL_MS = 60 * 60_000
const now = atom({ plugin: 'session-cost', key: 'now' } as const, 0)

const KINDS: readonly RateKind[] = ['five_hour', 'seven_day']
const NO_CALIBRATION: Calibration = { dPct: 0, usd: 0, n: 0 }
const EMPTY_USAGE: UsageLedger = {
  instance: '',
  spend: {},
  others: {},
  readings: {},
  calibration: { five_hour: NO_CALIBRATION, seven_day: NO_CALIBRATION },
}
// What this machine has spent against the plan's windows, and the factor learned from it.
const usage = atom({ plugin: 'session-cost', key: 'usage' } as const, EMPTY_USAGE, { shape: 'usage-1' })
/** The store is written at most this often, and when a turn ends. */
const SAVE_EVERY_MS = 10_000

// ---------------------------------------------------------------------------
// Pricing: first-party list prices, USD per million tokens (cached 2026-11).
// Cache writes are priced at the 5-minute rate (1.25x input); the API's usage
// counts do not split 5m from 1h writes, so 1h writes (2x) land in "Other".
// Order matters: the more specific id comes first ("opus-5-5" before "opus-5").
// ---------------------------------------------------------------------------
type Price = { input: number; output: number; cacheRead: number }

const PRICES: ReadonlyArray<readonly [string, Price]> = [
  ['fable-5-2', { input: 8, output: 40, cacheRead: 0.2 }],
  ['mythos-5-2', { input: 8, output: 40, cacheRead: 0.2 }],
  ['fable-5-1', { input: 10, output: 50, cacheRead: 1 }],
  ['mythos-5-1', { input: 10, output: 50, cacheRead: 1 }],
  ['fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['mythos', { input: 10, output: 50, cacheRead: 1 }],
  ['opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['opus-4-8', { input: 5, output: 25, cacheRead: 0.5 }],
  ['opus-4-7', { input: 5, output: 25, cacheRead: 0.5 }],
  ['opus-4-6', { input: 5, output: 25, cacheRead: 0.5 }],
  ['opus-4-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['opus-4', { input: 15, output: 75, cacheRead: 1.5 }],
  ['sonnet-5-5', { input: 2, output: 10, cacheRead: 0.1 }],
  ['sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['sonnet-4', { input: 3, output: 15, cacheRead: 0.3 }],
  ['haiku-5-5', { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ['haiku-4-5', { input: 1, output: 5, cacheRead: 0.1 }],
  ['haiku-3-5', { input: 0.8, output: 4, cacheRead: 0.08 }],
]
const CACHE_WRITE_FACTOR = 1.25
const WEB_SEARCH_USD = 10 / 1000

const priceOf = (model: string): Price | null => {
  const id = model.toLowerCase().replace(/\./g, '-')
  for (const [key, price] of PRICES) {
    if (id.includes(key)) return price
  }
  return null
}

type Cost = Tokens

const ZERO: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const costOf = (row: ModelRow): Cost | null => {
  const p = priceOf(row.model)
  if (p === null) return null
  const m = 1_000_000
  return {
    input: (row.input * p.input) / m,
    output: (row.output * p.output) / m,
    cacheRead: (row.cacheRead * p.cacheRead) / m,
    cacheWrite: (row.cacheWrite * p.input * CACHE_WRITE_FACTOR) / m,
  }
}

const sumCost = (c: Cost) => c.input + c.output + c.cacheRead + c.cacheWrite
const addCost = (a: Cost, b: Cost): Cost => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

/** Priced sum over a set of model rows, and the models without a price. */
const priceRows = (models: Record<string, ModelRow>) => {
  let cost = ZERO
  const unpriced: string[] = []
  for (const row of Object.values(models)) {
    const c = costOf(row)
    if (c === null) unpriced.push(row.model)
    else cost = addCost(cost, c)
  }
  return { cost, unpriced }
}

const addUsage = (
  models: Record<string, ModelRow>,
  model: string,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
): Record<string, ModelRow> => {
  const prev: ModelRow = models[model] ?? {
    model,
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
  return {
    ...models,
    [model]: {
      ...prev,
      requests: prev.requests + 1,
      input: prev.input + u.input_tokens,
      output: prev.output + u.output_tokens,
      cacheRead: prev.cacheRead + u.cache_read_input_tokens,
      cacheWrite: prev.cacheWrite + u.cache_creation_input_tokens,
    },
  }
}

/** The turn a response or a search belongs to: the open one, else the last. */
const turnIndexFor = (turns: readonly TurnRow[]) => {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]?.isOpen) return i
  return turns.length - 1
}

const usd = (n: number) =>
  n === 0 ? '$0' : Math.abs(n) >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`

const tok = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : `${n}`

const pct = (part: number, whole: number) => (whole <= 0 ? '' : `${Math.round((part / whole) * 100)}%`)

const shortModel = (model: string) => model.replace(/^.*?claude-/, '')

const two = (n: number) => String(n).padStart(2, '0')

/** 42s -> "0:42", 3723s -> "1:02:03". */
const dur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`
}

/** Local wall-clock time, HH:mm:ss. */
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** 63s -> "01:03", 3600s -> "60:00": five cells wide, so a ticking figure never shifts the row. */
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${two(Math.floor(s / 60))}:${two(s % 60)}`
}

/** Cells a string takes on the row: emoji draw two, the rest one. */
const cells = (s: string) => {
  let n = 0
  for (const ch of s) n += /[⌚⌛⏩-⏳⚡\u{1F300}-\u{1FAFF}]/u.test(ch) ? 2 : 1
  return n
}



// ---------------------------------------------------------------------------
// Per-turn view: what each turn cost, split by category and by source.
// ---------------------------------------------------------------------------
type TurnAgentView = { label: string; usd: number; models: string[] }

type TurnView = {
  n: number
  prompt: string
  isOpen: boolean
  usd: number
  /** By token category. */
  parts: { input: number; cacheWrite: number; cacheRead: number; output: number; search: number; other: number }
  /** By who spent it: the main thread, the subagents, web search, the rest. */
  source: { main: number; subagents: number; search: number; other: number }
  byModel: Array<{ model: string; usd: number }>
  byAgent: TurnAgentView[]
}

const viewTurn = (t: TurnRow, liveTotal: number | null): TurnView => {
  const { cost } = priceRows(t.models)
  const search = t.webSearches * WEB_SEARCH_USD
  const computed = sumCost(cost) + search
  const after = t.isOpen ? liveTotal : t.totalAfter
  const engine = t.totalBefore !== null && after !== null ? after - t.totalBefore : null
  const value = engine === null ? computed : Math.max(engine, computed)
  const other = Math.max(0, value - computed)
  const byModel = Object.values(t.models)
    .map(r => ({ model: r.model, usd: (c => (c === null ? 0 : sumCost(c)))(costOf(r)) }))
    .sort((a, b) => b.usd - a.usd)
  const byAgent = Object.values(t.agents ?? {})
    .map(a => ({
      label: a.description ? `${a.type}: ${a.description}` : a.type,
      usd: sumCost(priceRows(a.models).cost),
      models: Object.keys(a.models).map(shortModel),
    }))
    .sort((a, b) => b.usd - a.usd)
  const subagents = byAgent.reduce((n, a) => n + a.usd, 0)
  return {
    n: t.n,
    prompt: t.prompt,
    isOpen: t.isOpen,
    usd: value,
    parts: { ...cost, search, other },
    source: { main: Math.max(0, sumCost(cost) - subagents), subagents, search, other },
    byModel,
    byAgent,
  }
}

const CATEGORY_SERIES = [
  { key: 'input', label: 'Input', color: '#5B8DEF' },
  { key: 'cacheWrite', label: 'Cache write', color: '#F2A541' },
  { key: 'cacheRead', label: 'Cache read', color: '#4CB782' },
  { key: 'output', label: 'Output', color: '#B36BE0' },
  { key: 'search', label: 'Web search', color: '#E8697B' },
  { key: 'other', label: 'Other', color: '#9AA0A6' },
] as const

const SOURCE_SERIES = [
  { key: 'main', label: 'Main thread', color: '#5B8DEF' },
  { key: 'subagents', label: 'Subagents', color: '#C77DFF' },
  { key: 'search', label: 'Web search', color: '#E8697B' },
  { key: 'other', label: 'Other', color: '#9AA0A6' },
] as const

type Series = ReadonlyArray<{ key: string; label: string; color: string }>

const seriesFor = (mode: ChartMode): Series => (mode === 'source' ? SOURCE_SERIES : CATEGORY_SERIES)

const valuesFor = (t: TurnView, mode: ChartMode): Record<string, number> =>
  mode === 'source' ? t.source : t.parts

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * A stacked bar chart of the turns' cost. Hovering a bar shows its breakdown in a
 * tooltip drawn by the SVG itself (CSS :hover), since a native <title> tooltip does
 * not show in every frame.
 */
const chartSvg = (turns: readonly TurnView[], width: number, height: number, mode: ChartMode): string => {
  const series = seriesFor(mode)
  const W = Math.round(width)
  const H = Math.round(height)
  const left = 64
  const right = 12
  const top = 16
  const bottom = 64
  const plotW = W - left - right
  const plotH = H - top - bottom
  const max = Math.max(...turns.map(t => t.usd), 0.0001)
  const slot = plotW / Math.max(turns.length, 1)
  const barW = Math.max(4, Math.min(48, slot * 0.7))
  const y = (v: number) => top + plotH - (v / max) * plotH
  const out: string[] = []
  const css = [
    '.t{display:none;pointer-events:none}',
    '.b .hit{fill:transparent}',
    '.b:hover .hit{fill:#8882}',
    ...turns.map((_, i) => `.b${i}:hover~.t${i}{display:inline}`),
  ].join('')
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="13"><style>${css}</style>`,
  )
  // Grid and the y axis: 0, quarters, max.
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const yy = y(max * f)
    out.push(`<line x1="${left}" x2="${W - right}" y1="${yy}" y2="${yy}" stroke="#8884" stroke-width="1"${f === 0 ? '' : ' stroke-dasharray="3 4"'}/>`)
    out.push(`<text x="${left - 8}" y="${yy + 4}" text-anchor="end" fill="#888">${xml(usd(max * f))}</text>`)
  }
  const labelTotals = slot >= 44
  const every = Math.ceil(turns.length / Math.max(6, Math.floor(plotW / 36)))
  // The bars, each a hover target over its whole column.
  turns.forEach((t, i) => {
    const x = left + i * slot + (slot - barW) / 2
    const values = valuesFor(t, mode)
    out.push(`<g class="b b${i}"><rect class="hit" x="${left + i * slot}" y="${top}" width="${slot}" height="${plotH}"/>`)
    let acc = 0
    for (const s of series) {
      const v = values[s.key] ?? 0
      if (v <= 0) continue
      const y1 = y(acc + v)
      const h = Math.max(0.5, y(acc) - y1)
      out.push(`<rect x="${x}" y="${y1}" width="${barW}" height="${h}" rx="2" fill="${s.color}"${t.isOpen ? ' opacity="0.55"' : ''}/>`)
      acc += v
    }
    if (labelTotals) {
      out.push(`<text x="${x + barW / 2}" y="${y(t.usd) - 5}" text-anchor="middle" font-size="11" fill="#888">${xml(usd(t.usd))}</text>`)
    }
    out.push('</g>')
    if (i % every === 0 || i === turns.length - 1) {
      out.push(`<text x="${x + barW / 2}" y="${top + plotH + 18}" text-anchor="middle" fill="#888">#${t.n}</text>`)
    }
  })
  // The tooltips, after every bar so they paint on top; each shown by its bar's hover.
  turns.forEach((t, i) => {
    const values = valuesFor(t, mode)
    type Line = { text: string; color?: string; bold?: boolean; dim?: boolean }
    const lines: Line[] = [
      { text: `Turn #${t.n}${t.isOpen ? ' (running)' : ''}   ${usd(t.usd)}`, bold: true },
      ...series
        .filter(s => (values[s.key] ?? 0) > 0)
        .map(s => ({ text: `${s.label}   ${usd(values[s.key] ?? 0)}`, color: s.color })),
    ]
    if (t.byAgent.length > 0) {
      lines.push({ text: 'Subagents', bold: true })
      for (const a of t.byAgent.slice(0, 6)) {
        lines.push({ text: `  ${clip(a.label, 34)} (${a.models.join(', ')})   ${usd(a.usd)}`, color: '#C77DFF' })
      }
      if (t.byAgent.length > 6) lines.push({ text: `  +${t.byAgent.length - 6} more`, dim: true })
    }
    if (t.byModel.length > 0) {
      lines.push({ text: 'Models', bold: true })
      for (const m of t.byModel.slice(0, 4)) lines.push({ text: `  ${shortModel(m.model)}   ${usd(m.usd)}`, dim: true })
    }
    if (t.prompt) lines.push({ text: `“${clip(t.prompt, 46)}”`, dim: true })
    const lineH = 18
    const tw = Math.min(W - 8, Math.max(200, Math.max(...lines.map(l => l.text.length)) * 7.2 + 28))
    const th = lines.length * lineH + 14
    const cx = left + i * slot + slot / 2
    const tx = Math.max(4, Math.min(W - tw - 4, cx < W / 2 ? cx + 14 : cx - 14 - tw))
    const ty = Math.max(4, Math.min(H - th - 4, top + 4))
    out.push(`<g class="t t${i}" transform="translate(${tx.toFixed(1)},${ty.toFixed(1)})">`)
    out.push(`<rect width="${tw.toFixed(1)}" height="${th}" rx="8" fill="#1e1e22" stroke="#555" opacity="0.97"/>`)
    lines.forEach((l, k) => {
      const ly = 12 + (k + 1) * lineH - 5
      if (l.color && !l.text.startsWith('  ')) {
        out.push(`<rect x="12" y="${ly - 10}" width="10" height="10" rx="2" fill="${l.color}"/>`)
      }
      const lx = l.color && !l.text.startsWith('  ') ? 28 : 12
      const fill = l.dim ? '#9a9aa2' : l.color && l.text.startsWith('  ') ? l.color : '#ececf1'
      out.push(`<text x="${lx}" y="${ly}" fill="${fill}"${l.bold ? ' font-weight="600"' : ''} xml:space="preserve">${xml(l.text)}</text>`)
    })
    out.push('</g>')
  })
  // Legend.
  let lx = left
  for (const s of series) {
    out.push(`<rect x="${lx}" y="${H - 22}" width="12" height="12" rx="3" fill="${s.color}"/>`)
    out.push(`<text x="${lx + 17}" y="${H - 12}" fill="#888">${s.label}</text>`)
    lx += 17 + s.label.length * 7.4 + 16
  }
  out.push('</svg>')
  return out.join('')
}

/** The context bar on a desktop: a rounded track, filled with a soft gradient. */
const PILL_W = 84
const PILL_H = 10
const PILL_COLORS: Record<string, readonly [string, string]> = {
  green: ['#2ea043', '#56d364'],
  yellow: ['#d29922', '#f2cc60'],
  red: ['#da3633', '#ff7b72'],
  gray: ['#6e7681', '#8b949e'],
}
const pillSvg = (percent: number | null, tone: string): string => {
  const [from, to] = PILL_COLORS[tone] ?? PILL_COLORS.gray ?? ['#888', '#aaa']
  const r = PILL_H / 2
  const fill = percent === null ? 0 : Math.max(0, Math.min(1, percent / 100)) * PILL_W
  const w = fill > 0 ? Math.max(PILL_H, fill) : 0
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PILL_W} ${PILL_H}" width="${PILL_W}" height="${PILL_H}">` +
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>` +
    `<clipPath id="c"><rect width="${PILL_W}" height="${PILL_H}" rx="${r}"/></clipPath></defs>` +
    `<rect width="${PILL_W}" height="${PILL_H}" rx="${r}" fill="#8b949e" fill-opacity="0.22"/>` +
    (w > 0 ? `<rect width="${w.toFixed(1)}" height="${PILL_H}" rx="${r}" fill="url(#g)" clip-path="url(#c)"/>` : '') +
    `</svg>`
  )
}

// ---------------------------------------------------------------------------
// The pane's drawing kit: model names and colours, compact figures, thin bars.
// ---------------------------------------------------------------------------

/** A model family's colour: the stripe on its agent's card. */
const familyColor = (model: string | undefined) => {
  const id = (model ?? '').toLowerCase()
  if (id.includes('opus')) return '#B36BE0'
  if (id.includes('sonnet')) return '#5B8DEF'
  if (id.includes('haiku')) return '#3FB8AF'
  if (id.includes('fable') || id.includes('mythos')) return '#F2A541'
  return '#9AA0A6'
}

/** "claude-haiku-5-5-20261001[1m]" -> "Haiku 5.5". */
const prettyModel = (model: string | undefined) => {
  if (!model) return ''
  const parts = model
    .replace(/\[.*?\]$/, '')
    .replace(/^.*?claude-/, '')
    .split('-')
    .filter(p => !/^\d{8}$/.test(p))
  const [family, ...version] = parts
  if (!family) return model
  return `${family[0]?.toUpperCase() ?? ''}${family.slice(1)}${version.length > 0 ? ` ${version.join('.')}` : ''}`
}

/** Tokens the way a glance reads them: 940, 5.8k, 58k, 1.2M. */
const ktok = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 10_000
      ? `${Math.round(n / 1000)}k`
      : n >= 1_000
        ? `${(n / 1000).toFixed(1)}k`
        : `${n}`

const sumTokens = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite

/** One line's bar on a desktop: a rounded track and its fill. */
const railSvg = (width: number, fraction: number, color: string, height = 4): string => {
  const W = Math.max(8, Math.round(width))
  const r = height / 2
  const f = Math.max(0, Math.min(1, fraction)) * W
  const w = f > 0 ? Math.max(height, f) : 0
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}">` +
    `<rect width="${W}" height="${height}" rx="${r}" fill="#8b949e" fill-opacity="0.22"/>` +
    (w > 0 ? `<rect width="${w.toFixed(1)}" height="${height}" rx="${r}" fill="${color}"/>` : '') +
    `</svg>`
  )
}

/** A bar split into parts, each its colour, in a rounded track. */
const splitSvg = (width: number, parts: ReadonlyArray<{ value: number; color: string }>, height = 8): string => {
  const W = Math.max(8, Math.round(width))
  const whole = parts.reduce((n, p) => n + Math.max(0, p.value), 0)
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}">`,
    `<defs><clipPath id="s"><rect width="${W}" height="${height}" rx="${height / 2}"/></clipPath></defs>`,
    `<rect width="${W}" height="${height}" rx="${height / 2}" fill="#8b949e" fill-opacity="0.22"/>`,
    '<g clip-path="url(#s)">',
  ]
  let x = 0
  for (const p of parts) {
    if (whole <= 0 || p.value <= 0) continue
    const w = (p.value / whole) * W
    out.push(`<rect x="${x.toFixed(1)}" width="${(w + 0.5).toFixed(1)}" height="${height}" fill="${p.color}"/>`)
    x += w
  }
  out.push('</g></svg>')
  return out.join('')
}

/** The same bar on a terminal: cells of blocks, each part its colour. */
const splitCells = (cells: number, parts: ReadonlyArray<{ value: number; color: string }>) => {
  const whole = parts.reduce((n, p) => n + Math.max(0, p.value), 0)
  let used = 0
  const out: Array<{ n: number; color: string }> = []
  for (const p of parts) {
    if (whole <= 0 || p.value <= 0) continue
    const n = Math.min(cells - used, Math.max(1, Math.round((p.value / whole) * cells)))
    if (n > 0) out.push({ n, color: p.color })
    used += Math.max(0, n)
  }
  return { parts: out, rest: Math.max(0, cells - used) }
}

/** What a step cost by token type, at its model's price. */
const stepParts = (s: AgentStep) => {
  const c = costOf({ ...s, requests: 1 }) ?? ZERO
  return { input: c.input, cacheWrite: c.cacheWrite, cacheRead: c.cacheRead, output: c.output }
}

const SPARK = '▁▂▃▄▅▆▇█'
const spark = (values: readonly number[]) => {
  const max = Math.max(...values, 1e-12)
  return values.map(v => SPARK[Math.min(7, Math.round((v / max) * 7))] ?? '▁').join('')
}

/**
 * A subagent's requests in order, each a bar stacked by what its tokens cost, with
 * the running total drawn over them; a bar's hover shows its figures.
 */
const stepsSvg = (steps: readonly AgentStep[], width: number, height: number, startedAt: number | null): string => {
  const W = Math.round(width)
  const H = Math.round(height)
  const left = 52
  const right = 52
  const top = 12
  const bottom = 22
  const plotW = W - left - right
  const plotH = H - top - bottom
  const max = Math.max(...steps.map(s => s.usd), 0.000001)
  const totalUsd = steps.reduce((n, s) => n + s.usd, 0)
  const slot = plotW / Math.max(steps.length, 1)
  const barW = Math.max(2, Math.min(28, slot * 0.68))
  const y = (v: number) => top + plotH - (v / max) * plotH
  const yc = (v: number) => top + plotH - (v / Math.max(totalUsd, 1e-9)) * plotH
  const series = CATEGORY_SERIES.filter(s => s.key !== 'search' && s.key !== 'other')
  const css = [
    '.t{display:none;pointer-events:none}',
    '.b .hit{fill:transparent}',
    '.b:hover .hit{fill:#8882}',
    ...steps.map((_, i) => `.b${i}:hover~.t${i}{display:inline}`),
  ].join('')
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="11"><style>${css}</style>`,
  ]
  for (const f of [0, 0.5, 1]) {
    const yy = y(max * f)
    out.push(`<line x1="${left}" x2="${W - right}" y1="${yy}" y2="${yy}" stroke="#8884"${f === 0 ? '' : ' stroke-dasharray="2 4"'}/>`)
    out.push(`<text x="${left - 6}" y="${yy + 4}" text-anchor="end" fill="#888">${xml(usd(max * f))}</text>`)
  }
  let acc = 0
  const line: string[] = []
  steps.forEach((s, i) => {
    const x = left + i * slot + (slot - barW) / 2
    const parts = stepParts(s)
    out.push(`<g class="b b${i}"><rect class="hit" x="${left + i * slot}" y="${top}" width="${slot}" height="${plotH}"/>`)
    let stack = 0
    for (const k of series) {
      const v = parts[k.key as keyof typeof parts]
      if (v <= 0) continue
      const y1 = y(stack + v)
      out.push(`<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, y(stack) - y1).toFixed(1)}" fill="${k.color}"/>`)
      stack += v
    }
    out.push('</g>')
    acc += s.usd
    line.push(`${(x + barW / 2).toFixed(1)},${yc(acc).toFixed(1)}`)
  })
  // The running total, on its own scale at the right.
  if (steps.length > 1) {
    out.push(`<polyline points="${line.join(' ')}" fill="none" stroke="#c9c9cf" stroke-width="1.5" stroke-linejoin="round" opacity="0.8"/>`)
  }
  out.push(`<text x="${W - right + 6}" y="${yc(totalUsd) + 4}" fill="#c9c9cf">${xml(usd(totalUsd))}</text>`)
  out.push(`<text x="${W - right + 6}" y="${top + plotH + 4}" fill="#888">total</text>`)
  // The time axis: the first and the last request, from the agent's start.
  const first = steps[0]
  const last = steps[steps.length - 1]
  if (first && last && startedAt !== null) {
    out.push(`<text x="${left}" y="${H - 6}" fill="#888">${dur(first.at - startedAt)}</text>`)
    out.push(`<text x="${W - right}" y="${H - 6}" text-anchor="end" fill="#888">${dur(last.at - startedAt)}</text>`)
  }
  steps.forEach((s, i) => {
    const tps = s.ms >= 250 && s.output > 0 ? Math.round(s.output / (s.ms / 1000)) : null
    const lines = [
      `Request ${i + 1}${startedAt === null ? '' : ` at ${dur(s.at - startedAt)}`}   ${usd(s.usd)}`,
      `${prettyModel(s.model)}${tps === null ? '' : `, ${tps} tok/s`}`,
      `Input ${ktok(s.input)}   Output ${ktok(s.output)}`,
      `Cache read ${ktok(s.cacheRead)}   write ${ktok(s.cacheWrite)}`,
    ]
    const tw = Math.min(W - 8, Math.max(...lines.map(l => l.length)) * 6.6 + 24)
    const th = lines.length * 16 + 12
    const cx = left + i * slot + slot / 2
    const tx = Math.max(4, Math.min(W - tw - 4, cx < W / 2 ? cx + 10 : cx - 10 - tw))
    out.push(`<g class="t t${i}" transform="translate(${tx.toFixed(1)},${top})">`)
    out.push(`<rect width="${tw.toFixed(1)}" height="${th}" rx="6" fill="#1e1e22" stroke="#555" opacity="0.97"/>`)
    lines.forEach((l, k) => {
      out.push(`<text x="10" y="${20 + k * 16}" fill="${k === 0 ? '#ececf1' : '#a8a8b0'}"${k === 0 ? ' font-weight="600"' : ''} xml:space="preserve">${xml(l)}</text>`)
    })
    out.push('</g>')
  })
  out.push('</svg>')
  return out.join('')
}

const RUNNING = new Set(['running', 'pending', 'waiting'])

const statusMark = (status: string, isAborted?: boolean) =>
  RUNNING.has(status)
    ? { glyph: '●', color: 'success', word: status === 'running' ? 'Running' : status === 'pending' ? 'Starting' : 'Waiting' }
    : status === 'failed'
      ? { glyph: '✕', color: 'error', word: 'Failed' }
      : status === 'killed' || isAborted
        ? { glyph: '■', color: 'warning', word: 'Stopped' }
        : { glyph: '✓', color: 'success', word: 'Finished' }

// ---------------------------------------------------------------------------
// Engine calls (top-level so the engine can follow `$`).
// ---------------------------------------------------------------------------
async function refreshTotal($: EngineInterface) {
  const usage = await $.session.usage()
  const value = usage.cost?.usd ?? null
  await update($, total, () => value)
  if (usage.startedAt > 0) await update($, startedAt, v => v ?? usage.startedAt)
  return value
}

async function openPane($: EngineInterface) {
  await refreshTotal($)
  await $.ui.open({ id: PANE, title: TITLE })
}

/**
 * The context fill as /context and Claude Code's own meter read it: tokens over the
 * compaction window (`rawMaxTokens`, which may be smaller than the model's window).
 * A `summary` breakdown estimates locally and sends no request.
 */
async function refreshContext($: EngineInterface) {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  const fill: ContextFill = b
    ? { tokens: b.totalTokens, window: b.rawMaxTokens, percent: b.percentage }
    : { tokens: usage.context.tokens ?? null, window: usage.context.window, percent: usage.context.percent ?? null }
  await update($, contextFill, () => fill)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The spend a stored session record holds; junk reads as none. */
const storedSpend = (v: unknown): Record<string, number> =>
  !isRecord(v) || !isRecord(v.spend)
    ? {}
    : Object.fromEntries(
        Object.entries(v.spend).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])),
      )

const storedCalibration = (v: unknown): Record<RateKind, Calibration> | null => {
  if (!isRecord(v)) return null
  // Sums are never negative, and a million pairs is more than any session makes.
  const one = (c: unknown): Calibration | null =>
    isRecord(c) && [c.dPct, c.usd, c.n].every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0) && (c.n as number) <= 1_000_000
      ? { dPct: c.dPct as number, usd: c.usd as number, n: c.n as number }
      : null
  const five = one(v.five_hour)
  const seven = one(v.seven_day)
  return five && seven ? { five_hour: five, seven_day: seven } : null
}

let lastSave = 0
/** A read of the store has succeeded in this load of the module. */
let storeReadable = false

/** Writes this session's spend and the calibration to the store; a failing store is no harm. */
async function saveUsage($: EngineInterface, force = false) {
  const t = await $.clock.now()
  if (!force && t - lastSave < SAVE_EVERY_MS) return
  lastSave = t
  const l = await read($, usage)
  if (l.instance === '') return
  try {
    await $.store.set(`usage-${l.instance}`, { spend: pruneSpend(l.spend, t), at: t })
    // Never over what an unreadable store may hold: only once a read has succeeded.
    if (storeReadable) await $.store.set('calibration', l.calibration)
  } catch {
    // The figures stay in memory; the next write tries again.
  }
}

/** Names this session, and reads the other sessions' spend and the shared calibration. */
async function loadUsage($: EngineInterface) {
  const t = await $.clock.now()
  const mine = (await read($, usage)).instance
  const instance = mine !== '' ? mine : `${t.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  // null while the store has not been read: what the session knew stands.
  let others: Record<string, number> | null = null
  let stored: Record<RateKind, Calibration> | null = null
  const expired: string[] = []
  try {
    let pooled: Record<string, number> = {}
    for (const key of await $.store.keys()) {
      if (!key.startsWith('usage-') || key === `usage-${instance}`) continue
      const record = await $.store.get(key)
      const at = isRecord(record) && typeof record.at === 'number' ? record.at : 0
      if (t - at > KEEP_MS) expired.push(key)
      else pooled = mergeSpend(pooled, storedSpend(record))
    }
    stored = storedCalibration(await $.store.get('calibration'))
    others = pooled
    storeReadable = true
  } catch {
    // No store, or an unreadable one: this session's own figures, and what it knew, stand.
  }
  // A record of a session that ended more than a week ago holds nothing the windows still count.
  for (const key of expired) {
    try {
      await $.store.delete(key)
    } catch {
      // Left for the next load.
    }
  }
  const fresh = others
  await update($, usage, l => ({
    ...l,
    instance,
    spend: pruneSpend(l.spend, t),
    others: fresh === null ? l.others : pruneSpend(fresh, t),
    // Of what is stored and what this session holds, the one with more pairs behind it.
    calibration: {
      five_hour: stored && stored.five_hour.n > l.calibration.five_hour.n ? stored.five_hour : l.calibration.five_hour,
      seven_day: stored && stored.seven_day.n > l.calibration.seven_day.n ? stored.seven_day : l.calibration.seven_day,
    },
  }))
}

/** A response cost `cost` dollars: book it, read the windows, and learn from a close pair. */
async function recordResponse($: EngineInterface, cost: number) {
  const at = await $.clock.now()
  const readings: Partial<Record<RateKind, Reading>> = {}
  const reported = (await $.session.usage()).rateLimits
  for (const r of reported) {
    if ((r.kind === 'five_hour' || r.kind === 'seven_day') && r.resetsAt !== undefined) {
      readings[r.kind] = { percent: r.percentUsed, resetsAt: r.resetsAt, at }
    }
  }
  await update($, usage, l => {
    let calibration = l.calibration
    for (const kind of KINDS) {
      const next = readings[kind]
      const prev = l.readings[kind]
      // A response that cost nothing (no price) moved the account without a dollar to learn from.
      if (next && prev && cost > 0 && qualifies(prev, next)) {
        calibration = { ...calibration, [kind]: learn(calibration[kind], next.percent - prev.percent, cost) }
      }
    }
    // An account reporting no windows at all has left the subscription: the old readings go.
    return {
      ...l,
      spend: addSpend(l.spend, at, cost),
      readings: reported.length === 0 ? {} : { ...l.readings, ...readings },
      calibration,
    }
  })
  await saveUsage($)
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)
}

/** An agent's type and task, read while the engine still lists it. */
async function describeAgent($: EngineInterface, id: string) {
  const found = (await $.agent.list()).find(a => a.id === id)
  return found
    ? { type: found.type, description: found.description }
    : { type: 'fork', description: 'engine fork (compaction, memory, workflow)' }
}


/** A subagent's row before its first response. */
const blankAgent = (id: string, type: string, description: string, turn: number): AgentRow => ({
  id,
  type,
  description,
  requests: 0,
  models: {},
  webSearches: 0,
  turn,
  contextTokens: 0,
  outputMs: 0,
  steps: [],
  tools: {},
})

const clean = (s: string, n: number) => clip(s.replace(/\s+/g, ' ').trim(), n)

let ticker: { cancel: () => void } | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // No status line: the engine labels it with the mod's name and it takes no click.
    // This clears one an earlier version pinned.
    $.ui.status(undefined)
    await refreshTotal($)
    await refreshContext($)
    await loadUsage($)
    // The band's clock: the time, the turn's timer and the cache countdown move each second.
    ticker?.cancel()
    ticker = $.clock.every(1000, () => {
      void tick($)
    })

    return next(e)
  })

  // The engine's own ledger: the authoritative total (what /cost shows).
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await refreshContext($)
    if (e.changed.includes('cost')) {
      const value = e.cost?.usd ?? null
      await update($, total, () => value)
      // With no turn open (a background subagent still working), the spend belongs to
      // the turn that started it: the last one.
      if (value !== null) {
        await update($, ledger, l => {
          const last = l.turns[l.turns.length - 1]
          if (!last || last.isOpen || l.turns.some(x => x.isOpen)) return l
          return { ...l, turns: [...l.turns.slice(0, -1), { ...last, totalAfter: value }] }
        })
      }
    }

    return next(e)
  })

  // A main-thread turn begins: open a row, note the total it starts from.
  on('turn.start', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const at = await $.clock.now()
      const known = (await read($, agentCosts))[agentId]
      const meta = known ?? (await describeAgent($, agentId))
      const turnNo = (await read($, ledger)).turnCount
      await update($, agentCosts, all => {
        const prev = all[agentId] ?? blankAgent(agentId, meta.type, meta.description, turnNo)
        return { ...all, [agentId]: { ...prev, startedAt: prev.startedAt ?? at, endedAt: undefined } }
      })
    }
    if (e.agentId === undefined) {
      const before = await read($, total)
      await update($, ledger, l => {
        const n = l.turnCount + 1
        const row: TurnRow = {
          n,
          turnId: e.turnId,
          prompt: e.text.replace(/\s+/g, ' ').trim().slice(0, 80),
          isOpen: true,
          totalBefore: before,
          totalAfter: before,
          models: {},
          webSearches: 0,
        }
        const turns = l.turns.map(t => (t.isOpen ? { ...t, isOpen: false } : t))
        return { ...l, turnCount: n, turns: [...turns, row].slice(-MAX_TURNS) }
      })
      const t = await $.clock.now()
      await update($, live, lv => ({
        ...lv,
        turnStartedAt: t,
        turnEndedAt: null,
        isRunning: true,
        streamingSince: null,
        turnOutput: 0,
        turnGenMs: 0,
      }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    const agentId = e.agentId
    if (agentId !== undefined) {
      const at = await $.clock.now()
      const answer = 'answer' in e && typeof e.answer === 'string' ? e.answer : ''
      await update($, agentCosts, all => {
        const row = all[agentId]
        if (!row) return all
        return {
          ...all,
          [agentId]: {
            ...row,
            startedAt: row.startedAt ?? at - e.durationMs,
            endedAt: at,
            answer: answer ? clean(answer, 600) : row.answer,
            isAborted: e.isAborted,
          },
        }
      })
    }
    if (e.agentId === undefined) {
      const ended = await $.clock.now()
      await update($, live, lv => ({ ...lv, isRunning: false, turnEndedAt: ended, streamingSince: null }))
      const after = await refreshTotal($)
      await update($, ledger, l => ({
        ...l,
        turns: l.turns.map(t =>
          t.turnId === e.turnId ? { ...t, isOpen: false, totalAfter: after ?? t.totalAfter } : t,
        ),
      }))
      await saveUsage($, true)
      await loadUsage($)
    }

    return ran
  })

  // Every model response, main thread and subagents: its token counts.
  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const begun = await $.clock.now()
    let first: number | null = null
    // The live rate, while the response streams: the characters that arrived (text,
    // visible thinking, tool arguments) at about four to a token, over the real time
    // since the first piece, written at most once a second.
    let chars = 0
    let wallStart = 0
    let lastWrite = 0
    const stream = next(e)
    for await (const chunk of stream) {
      if (!isMain && first === null) first = await $.clock.now()
      if (isMain) {
        if (first === null) {
          const at = await $.clock.now()
          first = at
          wallStart = Date.now()
          lastWrite = wallStart
          await update($, live, lv => ({ ...lv, streamingSince: at, liveTps: null }))
        }
        if (chunk.kind === 'text' || chunk.kind === 'thinking') chars += chunk.text.length
        else if (chunk.kind === 'input') chars += chunk.json.length
        const wall = Date.now()
        if (wall - lastWrite >= 1000 && chars > 0) {
          lastWrite = wall
          const rate = chars / 4 / ((wall - wallStart) / 1000)
          await update($, live, lv => ({ ...lv, liveTps: rate }))
        }
      }
      yield chunk
    }
    const r = await stream.result
    // Output tokens over the time from the first streamed piece to the end.
    const end = await $.clock.now()
    const ms = Math.max(1, end - (first ?? begun))
    if (isMain) {
      const out = r.usage?.output_tokens ?? 0
      await update($, live, lv => ({
        ...lv,
        streamingSince: null,
        liveTps: null,
        lastTps: out > 0 ? out / (ms / 1000) : lv.lastTps,
        turnOutput: lv.turnOutput + out,
        turnGenMs: lv.turnGenMs + (out > 0 ? ms : 0),
        lastResponseAt: r.usage === null ? lv.lastResponseAt : end,
      }))
    }
    const u = r.usage
    // What this response cost at list price; a model with no price costs nothing here.
    const stepRow = u === null ? undefined : addUsage({}, u.model, u)[u.model]
    const stepCost = stepRow ? costOf(stepRow) : null
    const stepUsd = stepCost === null ? 0 : sumCost(stepCost)
    const agentId = e.agentId
    let meta: { type: string; description: string } | null = null
    if (agentId !== undefined && u !== null) {
      const known = (await read($, agentCosts))[agentId]
      const found = known ?? (await describeAgent($, agentId))
      meta = { type: found.type, description: found.description }
      const m = meta
      const turnNo = (await read($, ledger)).turnCount
      const one = addUsage({}, u.model, u)[u.model]
      const c = one ? costOf(one) : null
      const s: AgentStep = {
        model: u.model,
        at: end,
        ms,
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
        usd: c === null ? 0 : sumCost(c),
      }
      const effort = e.effort === undefined ? undefined : String(e.effort)
      await update($, agentCosts, all => {
        const prev: AgentRow = all[agentId] ?? blankAgent(agentId, m.type, m.description, turnNo)
        return {
          ...all,
          [agentId]: {
            ...prev,
            requests: prev.requests + 1,
            models: addUsage(prev.models, u.model, u),
            model: u.model,
            effort: effort ?? prev.effort,
            startedAt: prev.startedAt ?? begun,
            contextTokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
            outputMs: prev.outputMs + (u.output_tokens > 0 ? ms : 0),
            steps: [...prev.steps, s].slice(-MAX_STEPS),
          },
        }
      })
    }
    const servers = r.serverToolUses ?? []
    if (u !== null || servers.length > 0) {
      await update($, ledger, l => {
        const serverTools = { ...l.serverTools }
        for (const s of servers) serverTools[s.name] = (serverTools[s.name] ?? 0) + 1
        const apiSearches = servers.filter(s => s.name === 'web_search').length
        const i = turnIndexFor(l.turns)
        const turns =
          i < 0
            ? l.turns
            : l.turns.map((t, j) =>
                j !== i
                  ? t
                  : {
                      ...t,
                      models: u === null ? t.models : addUsage(t.models, u.model, u),
                      webSearches: t.webSearches + apiSearches,
                      agents:
                        agentId === undefined || u === null || meta === null
                          ? t.agents
                          : {
                              ...t.agents,
                              [agentId]: ((prev: TurnAgentRow) => ({
                                ...prev,
                                models: addUsage(prev.models, u.model, u),
                              }))(
                                t.agents?.[agentId] ?? {
                                  type: meta.type,
                                  description: meta.description,
                                  models: {},
                                  webSearches: 0,
                                },
                              ),
                            },
                    },
              )
        return {
          ...l,
          models: u === null ? l.models : addUsage(l.models, u.model, u),
          serverTools,
          turns,
          subagentRequests: l.subagentRequests + (e.agentId !== undefined && u !== null ? 1 : 0),
        }
      })
    }
    if (u !== null) await recordResponse($, stepUsd)

    return r
  })

  // A subagent starts: its row, with the task it was given, before its first response.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const agentId = r.agentId
    if (agentId !== undefined) {
      const turnNo = (await read($, ledger)).turnCount
      const at = await $.clock.now()
      await update($, agentCosts, all => {
        const prev = all[agentId] ?? blankAgent(agentId, e.subagentType, e.description, turnNo)
        return {
          ...all,
          [agentId]: { ...prev, prompt: clean(e.prompt, 600), model: prev.model ?? r.model, startedAt: prev.startedAt ?? at },
        }
      })
    }

    return r
  })

  // Each tool a subagent calls, counted on its page.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      await update($, agentCosts, all => {
        const row = all[agentId]
        return row ? { ...all, [agentId]: { ...row, tools: { ...row.tools, [e.tool]: (row.tools[e.tool] ?? 0) + 1 } } } : all
      })
    }

    return next(e)
  })

  // Web search is billed per search ($10 / 1,000) on top of tokens.
  on('tool.call', { tool: 'WebSearch' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const count = ran.result?.searchCount ?? 1
      const agentId = e.agentId
      if (agentId !== undefined) {
        await update($, agentCosts, all => {
          const row = all[agentId]
          return row ? { ...all, [agentId]: { ...row, webSearches: row.webSearches + count } } : all
        })
      }
      await update($, ledger, l => {
        const i = turnIndexFor(l.turns)
        return {
          ...l,
          webSearches: l.webSearches + count,
          turns: l.turns.map((t, j) => {
            if (j !== i) return t
            const share = agentId === undefined ? undefined : t.agents?.[agentId]
            return {
              ...t,
              webSearches: t.webSearches + count,
              agents:
                share && agentId !== undefined
                  ? { ...t.agents, [agentId]: { ...share, webSearches: share.webSearches + count } }
                  : t.agents,
            }
          }),
        }
      })
    }

    return ran
  })

  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) {
      await update($, ledger, l => ({ ...l, webFetches: l.webFetches + 1 }))
    }

    return ran
  })

  // ---- The band right above the prompt: live session figures, a click opens the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e).Svg
    const value = await read($, total)
    const l = await read($, ledger)
    const lv = await read($, live)
    const ticked = await read($, now)
    const t = ticked > 0 ? ticked : await $.clock.now()

    const last = l.turns[l.turns.length - 1]
    const turnUsd = last ? viewTurn(last, value).usd : null
    const turnNo = last?.n ?? 0
    const elapsed =
      lv.turnStartedAt === null ? null : (lv.isRunning ? t : (lv.turnEndedAt ?? t)) - lv.turnStartedAt
    const tps = lv.streamingSince !== null && lv.liveTps !== null ? lv.liveTps : lv.lastTps
    const avgTps = lv.turnGenMs > 0 ? lv.turnOutput / (lv.turnGenMs / 1000) : null
    const cacheLeft = lv.lastResponseAt === null ? null : lv.lastResponseAt + CACHE_TTL_MS - t
    const cacheColor =
      cacheLeft === null ? undefined : cacheLeft <= 0 ? 'red' : cacheLeft < 60_000 ? 'yellow' : 'green'
    const money = (n: number | null) => (n === null ? '—' : usd(n))
    // Figures that tick are set to a fixed width, so the groups after them stay put.
    const timer = elapsed === null ? '--:--' : mmss(elapsed)
    const tpsText = (tps === null ? '—' : String(Math.round(tps))).padStart(3)

    // The context window's fill, as the status line has it: a short bar and its percent.
    const ctx = (await read($, contextFill)) ?? { tokens: null, window: 0, percent: null }
    const ctxPct =
      ctx.percent ?? (ctx.tokens !== null && ctx.window > 0 ? (ctx.tokens / ctx.window) * 100 : null)
    const ctxColor = ctxPct === null ? 'gray' : ctxPct >= 80 ? 'red' : ctxPct >= 50 ? 'yellow' : 'green'
    const CTX_BAR = 10
    const ctxFilled = ctxPct === null ? 0 : Math.min(CTX_BAR, Math.round((ctxPct / 100) * CTX_BAR))
    const ctxLabel = ctxPct === null ? '—' : `${Math.round(ctxPct)}%`

    // Each group leads with its icon; groups sit apart with no separator between them.
    // `text` measures the group (an emoji takes two cells), `keep` says how readily it
    // goes when the row is short.
    type Chip = { text: string; keep: number; node: ReturnType<typeof Text> | ReturnType<typeof Box> }
    // The plan's windows as the account reports them, four cells a figure so it never shifts.
    // A window whose reset has passed has no figure until the next response reads it again.
    const plan = await read($, usage)
    const livePct = (k: RateKind) => {
      const r = plan.readings[k]
      return r !== undefined && Date.parse(r.resetsAt) > t ? r.percent : null
    }
    const planFig = (k: RateKind) => {
      const p = livePct(k)
      return p === null ? '  --' : `${String(Math.round(p)).padStart(3)}%`
    }
    const planTop = Math.max(...KINDS.map(k => livePct(k) ?? 0))
    const planText = `5h ${planFig('five_hour')} 7d ${planFig('seven_day')}`
    const planColor = planTop >= 90 ? 'red' : planTop >= 70 ? 'yellow' : undefined
    // The cache's countdown is always mm:ss (60:00 down to 00:00), five cells.
    const cacheValue = cacheLeft === null ? '--:--' : cacheLeft <= 0 ? '00:00' : mmss(cacheLeft)
    const chips: Chip[] = [
      {
        // The current turn: running or idle, and for how long.
        text: `● #${turnNo} ${timer}`,
        keep: 98,
        node: (
          <Text>
            <Text color={lv.isRunning ? 'green' : 'gray'}>{lv.isRunning ? '●' : '○'}</Text>
            <Text bold>{` #${turnNo}`}</Text>
            <Text dimColor>{` ${timer}`}</Text>
          </Text>
        ),
      },
      {
        // Cost, one group: this turn (yellow) | the session as /cost totals it (green).
        text: `💰 ${money(turnUsd)} | ${money(value)}`,
        keep: 99,
        node: (
          <Text>
            <Text>💰 </Text>
            <Text bold color="yellow">{money(turnUsd)}</Text>
            <Text dimColor> | </Text>
            <Text bold color="green">{money(value)}</Text>
          </Text>
        ),
      },
      {
        // The context window: how full it is.
        text: `🧠 ${'━'.repeat(CTX_BAR)} ${ctxLabel}`,
        keep: 90,
        node: Svg ? (
          // A desktop draws a rounded pill; a terminal a thin line in two tones.
          <Box flexDirection="row" alignItems="center">
            <Text>🧠 </Text>
            <Svg source={pillSvg(ctxPct, ctxColor)} width={PILL_W} height={PILL_H} alt={`Context ${ctxLabel}`} />
            <Text bold color={ctxColor}>{` ${ctxLabel}`}</Text>
          </Box>
        ) : (
          <Text>
            <Text>🧠 </Text>
            <Text color={ctxColor}>{'━'.repeat(ctxFilled)}</Text>
            <Text dimColor>{'━'.repeat(CTX_BAR - ctxFilled)}</Text>
            <Text bold color={ctxColor}>{` ${ctxLabel}`}</Text>
          </Text>
        ),
      },
      {
        // The prompt cache: time left before the main thread's cache lapses.
        text: `⏳ ${cacheValue}`,
        // Kept ahead of the speed and the context bar: it is the last to go but the time and the turn.
        keep: 95,
        node: (
          <Text>
            <Text>{cacheLeft !== null && cacheLeft <= 0 ? '⌛ ' : '⏳ '}</Text>
            <Text color={cacheColor} bold={cacheLeft !== null && cacheLeft > 0 && cacheLeft < 60_000}>
              {cacheValue}
            </Text>
          </Text>
        ),
      },
      {
        // Speed: live while a response streams, the last response's rate otherwise.
        text: `⚡ ${tpsText}/s`,
        keep: 70,
        node: (
          <Text>
            <Text>⚡ </Text>
            <Text color="cyan" bold={lv.streamingSince !== null}>
              {tpsText}
            </Text>
            <Text dimColor>/s</Text>
          </Text>
        ),
      },
      ...(KINDS.some(k => livePct(k) !== null)
        ? [
            {
              // The account's use of the 5-hour and weekly windows; the first group to go.
              text: `📈 ${planText}`,
              keep: 60,
              node: (
                <Text>
                  <Text>📈 </Text>
                  <Text color={planColor}>{planText}</Text>
                </Text>
              ),
            },
          ]
        : []),
      {
        // Wall-clock time: always shown, however narrow the row.
        text: `🕒 ${clock(t)}`,
        keep: Infinity,
        node: (
          <Text>
            <Text>🕒 </Text>
            <Text dimColor>{clock(t)}</Text>
          </Text>
        ),
      },
    ]

    // Fit the row beside the button: drop the least needed groups first; the time stays.
    // One cell between groups: each opens with its icon, which is enough to tell them apart.
    // The row's width is counted in cells (an emoji takes two); the button is `[📊]` and
    // its two cells of margin.
    const GAP = ' '
    const room = e.props.bodyColumns - 6
    const kept = [...chips]
    const width = (list: Chip[]) =>
      list.reduce((a, c) => a + cells(c.text), 0) + Math.max(0, list.length - 1) * GAP.length
    while (width(kept) > room) {
      const droppable = kept.filter(c => c.keep !== Infinity)
      if (droppable.length <= 1) break
      const victim = droppable.reduce((a, c) => (c.keep < a.keep ? c : a))
      kept.splice(kept.indexOf(victim), 1)
    }

    // One row: the groups, then a small icon button at its end that opens the pane.
    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Box flexDirection="row" flexShrink={1} alignItems="center">
          {kept.map((c, i) => (
            <Box flexDirection="row" alignItems="center" marginLeft={i > 0 ? GAP.length : 0}>
              {c.node}
            </Box>
          ))}
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <Button key="session-cost-open" label="📊" hotkey="c" onPress={() => openPane($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e).Svg
    const l = await read($, ledger)
    const engineTotal = await read($, total)
    const current = await read($, tab)
    const ticked = await read($, now)
    const t = ticked > 0 ? ticked : await $.clock.now()
    const began = await read($, startedAt)
    const ctxFill = await read($, contextFill)
    const ctxWindow = ctxFill && ctxFill.window > 0 ? ctxFill.window : 200_000
    const agentRows = Object.values(await read($, agentCosts))
    const listed = await $.agent.list()

    const agentView = agentRows
      .map(a => {
        const priced = priceRows(a.models)
        const cost = sumCost(priced.cost) + a.webSearches * WEB_SEARCH_USD
        const tokens = Object.values(a.models).reduce((n, m) => n + sumTokens(m), 0)
        const status = listed.find(x => x.id === a.id)?.status ?? (a.isAborted ? 'killed' : 'completed')
        const isRunning = RUNNING.has(status)
        const lastAt = a.steps[a.steps.length - 1]?.at
        const end = isRunning ? t : (a.endedAt ?? lastAt ?? null)
        const elapsed = a.startedAt === undefined || end === null ? null : Math.max(0, end - a.startedAt)
        const ctxPct = a.contextTokens > 0 ? Math.min(100, (a.contextTokens / ctxWindow) * 100) : null
        return { ...a, cost, tokens, status, isRunning, elapsed, ctxPct }
      })
      .sort((x, y) => Number(y.isRunning) - Number(x.isRunning) || (y.startedAt ?? 0) - (x.startedAt ?? 0))
    type AgentView = (typeof agentView)[number]
    const subUsd = agentView.reduce((n, a) => n + a.cost, 0)

    const rows = Object.values(l.models)
    const { cost: sum, unpriced } = priceRows(l.models)
    const toks = rows.reduce<Tokens>(
      (a, r) => ({
        input: a.input + r.input,
        output: a.output + r.output,
        cacheRead: a.cacheRead + r.cacheRead,
        cacheWrite: a.cacheWrite + r.cacheWrite,
      }),
      ZERO,
    )
    const searchCount = l.webSearches + (l.serverTools['web_search'] ?? 0)
    const searchUsd = searchCount * WEB_SEARCH_USD
    const computed = sumCost(sum) + searchUsd
    const other = engineTotal === null ? null : engineTotal - computed
    const shown = engineTotal ?? computed
    const totalTokens = sumTokens(toks)
    const inputSide = toks.input + toks.cacheRead + toks.cacheWrite
    const hitRate = inputSide === 0 ? null : (toks.cacheRead / inputSide) * 100
    const requests = rows.reduce((a, r) => a + r.requests, 0)

    const cols = e.props.bodyColumns
    const narrow = cols < 46
    // About how many pixels a column takes on a desktop, to size the drawings.
    const PX = 7.5
    const W_LABEL = narrow ? 13 : 16
    const W_TOK = narrow ? 8 : 10
    const W_USD = 10
    const W_PCT = narrow ? 0 : 5

    const Row = (p: { label: string; tokens?: string; cost: string; share?: string; dim?: boolean; bold?: boolean; indent?: boolean; swatch?: string }) => (
      <Box flexDirection="row">
        <Box width={W_LABEL} flexDirection="row">
          {p.swatch && <Text color={p.swatch}>■ </Text>}
          <Text dimColor={p.dim} bold={p.bold} wrap="truncate-end">
            {p.indent ? `  ${p.label}` : p.label}
          </Text>
        </Box>
        <Box width={W_TOK} justifyContent="flex-end">
          <Text dimColor>{p.tokens ?? ''}</Text>
        </Box>
        <Box width={W_USD} justifyContent="flex-end">
          <Text dimColor={p.dim} bold={p.bold}>{p.cost}</Text>
        </Box>
        {W_PCT > 0 && (
          <Box width={W_PCT} justifyContent="flex-end">
            <Text dimColor>{p.share ?? ''}</Text>
          </Box>
        )}
      </Box>
    )

    /** A figure in a framed tile: a small label over a large value. */
    const Tile = (p: { label: string; value: string; color?: string; width: number }) => (
      <Box flexDirection="column" width={p.width} borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text dimColor wrap="truncate-end">{p.label}</Text>
        <Text bold color={p.color} wrap="truncate-end">
          {p.value}
        </Text>
      </Box>
    )
    const Tiles = (p: { items: ReadonlyArray<{ label: string; value: string; color?: string }> }) => {
      const gap = 1
      const width = Math.max(8, Math.floor((cols - gap * (p.items.length - 1)) / p.items.length))
      return (
        <Box flexDirection="row" gap={gap}>
          {p.items.map(i => (
            <Tile label={i.label} value={i.value} color={i.color} width={width} />
          ))}
        </Box>
      )
    }

    /** A bar of parts the width of `cells` columns: an Svg on a desktop, blocks on a terminal. */
    const Split = (p: { cells: number; parts: ReadonlyArray<{ value: number; color: string }>; alt: string; height?: number }) => {
      if (Svg) {
        const w = Math.round(p.cells * PX)
        const tall = p.height ?? 8
        return <Svg source={splitSvg(w, p.parts, tall)} width={w} height={tall} alt={p.alt} />
      }
      const cells = splitCells(p.cells, p.parts)
      return (
        <Text>
          {cells.parts.map(c => (
            <Text color={c.color}>{'━'.repeat(c.n)}</Text>
          ))}
          <Text dimColor>{'━'.repeat(cells.rest)}</Text>
        </Text>
      )
    }

    const Heading = (p: { text: string; hint?: string }) => (
      <Box flexDirection="row" marginTop={1} gap={1}>
        <Text bold>{p.text}</Text>
        {p.hint && <Text dimColor>{p.hint}</Text>}
      </Box>
    )

    const agentCount = agentView.length
    const runningCount = agentView.filter(a => a.isRunning).length
    const tabs = (
      <Box flexDirection="row" gap={1}>
        {(
          [
            ['summary', 'Summary', '1'],
            ['models', 'Models', '2'],
            ['agents', agentCount > 0 ? `Agents ${runningCount > 0 ? `●${runningCount}` : agentCount}` : 'Agents', '3'],
            ['turns', 'Turns', '4'],
            ['usage', 'Usage', '5'],
          ] as const
        ).map(([id, label, hotkey]) => (
          <Button
            key={`tab-${id}`}
            label={label}
            hotkey={hotkey}
            variant={current === id ? 'primary' : undefined}
            dimColor={current === id ? undefined : true}
            onPress={async () => {
              await update($, tab, () => id)
              // Back to the Agents tab: the list, or the agent whose transcript is in view.
              if (id === 'agents') await update($, selectedAgent, () => null)
              // The other sessions on this machine may have spent since this one last looked.
              if (id === 'usage') await loadUsage($)
            }}
          />
        ))}
      </Box>
    )

    const header = (
      <Box flexDirection="column">
        <Tiles
          items={[
            { label: engineTotal === null ? 'Cost (estimate)' : 'Cost', value: usd(shown), color: 'success' },
            { label: 'Tokens', value: ktok(totalTokens) },
            { label: 'Time', value: began === null ? '—' : dur(t - began) },
          ]}
        />
        <Text dimColor wrap="truncate-end">
          {requests} requests
          {l.subagentRequests > 0 ? `, ${l.subagentRequests} in subagents` : ''}
          {hitRate === null ? '' : `  ·  cache hit ${hitRate.toFixed(0)}%`}
        </Text>
      </Box>
    )

    // --- Summary -----------------------------------------------------------
    const categoryParts = [
      { value: sum.input, color: '#5B8DEF' },
      { value: sum.cacheWrite, color: '#F2A541' },
      { value: sum.cacheRead, color: '#4CB782' },
      { value: sum.output, color: '#B36BE0' },
      { value: searchUsd, color: '#E8697B' },
      { value: Math.max(0, other ?? 0), color: '#9AA0A6' },
    ]
    const summary = (
      <Box flexDirection="column">
        {shown > 0 && <Split cells={cols} parts={categoryParts} alt="The session's cost split by token type" />}
        <Text> </Text>
        <Row label="Item" tokens="Tokens" cost="USD" share="%" dim />
        <Row label="Input" swatch="#5B8DEF" tokens={tok(toks.input)} cost={usd(sum.input)} share={pct(sum.input, shown)} />
        <Row label="Output" swatch="#B36BE0" tokens={tok(toks.output)} cost={usd(sum.output)} share={pct(sum.output, shown)} />
        <Row label="Cache write" swatch="#F2A541" tokens={tok(toks.cacheWrite)} cost={usd(sum.cacheWrite)} share={pct(sum.cacheWrite, shown)} />
        <Row label="Cache read" swatch="#4CB782" tokens={tok(toks.cacheRead)} cost={usd(sum.cacheRead)} share={pct(sum.cacheRead, shown)} />
        <Row label="Web search" swatch="#E8697B" tokens={`${searchCount}x`} cost={usd(searchUsd)} share={pct(searchUsd, shown)} />
        {agentView.length > 0 && (
          <Row label="↳ Subagents" tokens={`${agentView.length} agents`} cost={usd(subUsd)} share={pct(subUsd, shown)} dim />
        )}
        {l.webFetches > 0 && <Row label="Web fetch" tokens={`${l.webFetches}x`} cost="tokens" dim />}
        {Object.entries(l.serverTools)
          .filter(([name]) => name !== 'web_search')
          .map(([name, n]) => (
            <Row label={name} tokens={`${n}x`} cost="tokens" dim />
          ))}
        {other !== null && Math.abs(other) >= 0.00005 && (
          <Row label="Other" swatch="#9AA0A6" cost={usd(other)} share={pct(other, shown)} dim />
        )}
      </Box>
    )

    // --- Models ------------------------------------------------------------
    const models = rows
      .map(r => ({ row: r, cost: costOf(r) }))
      .sort((a, b) => (b.cost ? sumCost(b.cost) : 0) - (a.cost ? sumCost(a.cost) : 0))
    const modelsView = (
      <Box flexDirection="column">
        {models.length === 0 && <Text dimColor>No model responses yet.</Text>}
        {models.map(({ row, cost }) => {
          const subtotal = cost === null ? null : sumCost(cost)
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Box flexDirection="row">
                <Text color={familyColor(row.model)}>▍</Text>
                <Row
                  label={shortModel(row.model)}
                  tokens={`${row.requests} req`}
                  cost={subtotal === null ? '?' : usd(subtotal)}
                  share={subtotal === null ? '' : pct(subtotal, shown)}
                  bold
                />
              </Box>
              <Row label="Input" indent tokens={tok(row.input)} cost={cost ? usd(cost.input) : '?'} dim />
              <Row label="Output" indent tokens={tok(row.output)} cost={cost ? usd(cost.output) : '?'} dim />
              <Row label="Cache write" indent tokens={tok(row.cacheWrite)} cost={cost ? usd(cost.cacheWrite) : '?'} dim />
              <Row label="Cache read" indent tokens={tok(row.cacheRead)} cost={cost ? usd(cost.cacheRead) : '?'} dim />
            </Box>
          )
        })}
        {searchCount > 0 && <Row label="Web search" tokens={`${searchCount}x`} cost={usd(searchUsd)} share={pct(searchUsd, shown)} bold />}
        {other !== null && Math.abs(other) >= 0.00005 && (
          <Row label="Other" cost={usd(other)} share={pct(other, shown)} dim />
        )}
      </Box>
    )

    // --- Agents: the list ---------------------------------------------------
    const mainUsd = Math.max(0, computed - subUsd)
    const priciest = Math.max(...agentView.map(a => a.cost), 1e-9)
    const fold = await read($, folded)
    const picked = await read($, selectedAgent)
    const inView = e.props.view.agentId
    const pageId = picked === null ? (inView !== undefined && agentView.some(a => a.id === inView) ? inView : null) : picked || null
    const page = agentView.find(a => a.id === pageId) ?? null
    const open = (id: string) => update($, selectedAgent, () => id)

    const cardMeta = (a: AgentView) =>
      [a.ctxPct === null ? null : `ctx ${Math.round(a.ctxPct)}%`, ktok(a.tokens)].filter(Boolean).join(' · ') +
      `  ≈${usd(a.cost)}` +
      (a.elapsed === null ? '' : `  ${dur(a.elapsed)}`)

    const Card = (p: { a: AgentView }) => {
      const a = p.a
      const mark = statusMark(a.status, a.isAborted)
      const inner = cols - 3
      return (
        <Box key={`card-${a.id}`} flexDirection="row" paddingY={0} marginTop={1} hover={{ backgroundColor: '#8b949e1f' }}>
          <Box width={2} flexShrink={0}>
            <Text color={familyColor(a.model)}>▍</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Button key={`agent-${a.id}`} plain label={a.description || a.type} onPress={() => open(a.id)} />
              <Text color={mark.color}>{mark.glyph}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {a.type}
              {a.model ? ` ${prettyModel(a.model)}` : ''}
              {a.effort ? ` · ${a.effort}` : ''}
            </Text>
            <Box flexDirection="row" justifyContent="flex-end">
              <Text dimColor>{cardMeta(a)}</Text>
            </Box>
            {Svg ? (
              <Svg
                source={railSvg(inner * PX, a.cost / priciest, a.isRunning ? '#4CB782' : '#8b949e', 4)}
                width={Math.round(inner * PX)}
                height={4}
                alt={`${usd(a.cost)}, ${pct(a.cost, subUsd) || '0%'} of the subagents' cost`}
              />
            ) : (
              <Text>
                <Text color={a.isRunning ? 'green' : undefined}>{'━'.repeat(Math.round((a.cost / priciest) * inner))}</Text>
                <Text dimColor>{'╌'.repeat(inner - Math.round((a.cost / priciest) * inner))}</Text>
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    const Group = (p: { id: AgentGroup; label: string; list: AgentView[] }) => {
      if (p.list.length === 0) return null
      const isFolded = fold[p.id] === true
      return (
        <Box flexDirection="column" marginTop={1}>
          <Button
            key={`fold-${p.id}`}
            plain
            dimColor
            label={`${isFolded ? '▸' : '▾'} ${p.label} · ${p.list.length}`}
            onPress={() => update($, folded, f => ({ ...f, [p.id]: !isFolded }))}
          />
          {!isFolded && p.list.map(a => <Card a={a} />)}
        </Box>
      )
    }

    const agentsList = (
      <Box flexDirection="column">
        {agentView.length === 0 && (
          <Text dimColor>No subagent has run yet. Each one the model starts shows here, with its cost as it runs.</Text>
        )}
        {agentView.length > 0 && (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text>
                <Text color="#5B8DEF">■ </Text>
                <Text>Main thread </Text>
                <Text bold>{usd(mainUsd)}</Text>
              </Text>
              <Text>
                <Text color="#C77DFF">■ </Text>
                <Text>Subagents </Text>
                <Text bold>{usd(subUsd)}</Text>
                <Text dimColor>{` ${pct(subUsd, mainUsd + subUsd)}`}</Text>
              </Text>
            </Box>
            <Split
              cells={cols}
              parts={[
                { value: mainUsd, color: '#5B8DEF' },
                { value: subUsd, color: '#C77DFF' },
              ]}
              alt={`Main thread ${usd(mainUsd)}, subagents ${usd(subUsd)}`}
              height={6}
            />
          </Box>
        )}
        <Group id="running" label="Running" list={agentView.filter(a => a.isRunning)} />
        <Group id="finished" label="Finished" list={agentView.filter(a => !a.isRunning)} />
      </Box>
    )

    // --- Agents: one agent's page --------------------------------------------
    const agentPage = (a: AgentView) => {
      const mark = statusMark(a.status, a.isAborted)
      const c = priceRows(a.models).cost
      const tk = Object.values(a.models).reduce<Tokens>(
        (n, m) => ({
          input: n.input + m.input,
          output: n.output + m.output,
          cacheRead: n.cacheRead + m.cacheRead,
          cacheWrite: n.cacheWrite + m.cacheWrite,
        }),
        ZERO,
      )
      const searchesUsd = a.webSearches * WEB_SEARCH_USD
      const side = tk.input + tk.cacheRead + tk.cacheWrite
      const hit = side === 0 ? null : Math.round((tk.cacheRead / side) * 100)
      const tps = a.outputMs >= 250 ? Math.round(tk.output / (a.outputMs / 1000)) : null
      const modelRows = Object.values(a.models)
      const tools = Object.entries(a.tools).sort((x, y) => y[1] - x[1])
      const toolCalls = tools.reduce((n, [, k]) => n + k, 0)
      const chartW = Math.min(1200, Math.max(360, Math.round(cols * PX)))
      const index = agentView.findIndex(x => x.id === a.id)
      const prev = agentView[index - 1]
      const nextAgent = agentView[index + 1]
      const lines = [
        { key: 'input', label: 'Input', color: '#5B8DEF', tokens: tk.input, usd: c.input },
        { key: 'output', label: 'Output', color: '#B36BE0', tokens: tk.output, usd: c.output },
        { key: 'cacheWrite', label: 'Cache write', color: '#F2A541', tokens: tk.cacheWrite, usd: c.cacheWrite },
        { key: 'cacheRead', label: 'Cache read', color: '#4CB782', tokens: tk.cacheRead, usd: c.cacheRead },
      ]
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Button key="agent-back" plain dimColor label="‹ All agents" onPress={() => update($, selectedAgent, () => '')} />
            <Box flexDirection="row" gap={1}>
              {prev && <Button key="agent-prev" plain dimColor label="↑" onPress={() => open(prev.id)} />}
              {nextAgent && <Button key="agent-next" plain dimColor label="↓" onPress={() => open(nextAgent.id)} />}
            </Box>
          </Box>
          <Box flexDirection="row" marginTop={1} gap={1}>
            <Text color={familyColor(a.model)}>▍</Text>
            <Box flexDirection="column" flexShrink={1}>
              <Text bold wrap="wrap">{a.description || a.type}</Text>
              <Text dimColor wrap="truncate-end">
                {a.type}
                {a.model ? ` ${prettyModel(a.model)}` : ''}
                {a.effort ? ` · ${a.effort}` : ''}
                {a.turn > 0 ? ` · from turn #${a.turn}` : ''}
              </Text>
              <Text color={mark.color}>
                {mark.glyph} {mark.word}
                <Text dimColor>{a.elapsed === null ? '' : ` after ${dur(a.elapsed)}`}</Text>
              </Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <Tiles
              items={[
                { label: 'Cost', value: `≈${usd(a.cost)}`, color: 'success' },
                { label: 'Tokens', value: ktok(a.tokens) },
                { label: 'Time', value: a.elapsed === null ? '—' : dur(a.elapsed) },
                ...(narrow ? [] : [{ label: 'Context', value: a.ctxPct === null ? '—' : `${Math.round(a.ctxPct)}%` }]),
              ]}
            />
          </Box>

          <Heading
            text="Requests"
            hint={
              a.steps.length === 0
                ? undefined
                : `${a.requests} in all, ≈${usd(a.cost / Math.max(1, a.requests))} each${tps === null ? '' : `, ${tps} tok/s out`}`
            }
          />
          {a.steps.length === 0 && <Text dimColor>No response yet.</Text>}
          {a.steps.length > 0 && Svg && (
            <Svg
              source={stepsSvg(a.steps, chartW, 150, a.startedAt ?? null)}
              width={chartW}
              height={150}
              alt={`${a.steps.length} requests, ${usd(a.cost)} in all`}
              isInteractive
            />
          )}
          {a.steps.length > 0 && !Svg && (
            <Box flexDirection="row">
              <Text color="#B36BE0">{spark(a.steps.slice(-(cols - 12)).map(s => s.usd))}</Text>
              <Text dimColor> {usd(Math.max(...a.steps.map(s => s.usd)))} max</Text>
            </Box>
          )}
          {a.steps.length > 0 && (
            <Text dimColor>
              {lines.map(s => (
                <Text>
                  <Text color={s.color}>■</Text>
                  {` ${s.label}  `}
                </Text>
              ))}
              {a.steps.length > 1 ? '─ running total' : ''}
            </Text>
          )}

          <Heading text="Cost by token type" hint={hit === null ? undefined : `cache hit ${hit}%`} />
          <Split cells={cols} parts={lines.map(s => ({ value: s.usd, color: s.color }))} alt="This agent's cost by token type" />
          {lines.map(s => (
            <Row label={s.label} swatch={s.color} tokens={tok(s.tokens)} cost={usd(s.usd)} share={pct(s.usd, a.cost)} />
          ))}
          {a.webSearches > 0 && (
            <Row label="Web search" swatch="#E8697B" tokens={`${a.webSearches}x`} cost={usd(searchesUsd)} share={pct(searchesUsd, a.cost)} />
          )}
          {modelRows.length > 1 && <Heading text="Models" />}
          {modelRows.length > 1 &&
            modelRows.map(m => {
              const mc = costOf(m)
              return (
                <Row label={shortModel(m.model)} swatch={familyColor(m.model)} tokens={`${m.requests} req`} cost={mc === null ? '?' : usd(sumCost(mc))} share={mc === null ? '' : pct(sumCost(mc), a.cost)} />
              )
            })}

          {tools.length > 0 && <Heading text="Tools" hint={`${toolCalls} calls`} />}
          {tools.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {tools.map(([name, n]) => (
                <Text>
                  {name}
                  <Text dimColor>{` ${n}`}</Text>
                </Text>
              ))}
            </Box>
          )}

          {a.prompt && <Heading text="Task" />}
          {a.prompt && (
            <Box borderStyle="round" borderColor="subtle" paddingX={1}>
              <Text dimColor wrap="wrap">{a.prompt}</Text>
            </Box>
          )}
          {a.answer && <Heading text={a.isRunning ? 'Last answer' : 'Answer'} />}
          {a.answer && (
            <Box borderStyle="round" borderColor="subtle" paddingX={1}>
              <Text wrap="wrap">{a.answer}</Text>
            </Box>
          )}
        </Box>
      )
    }

    // --- Turns -------------------------------------------------------------
    const turnViews = l.turns.map(tv => viewTurn(tv, engineTotal))
    const maxBars = Svg ? 40 : Math.max(5, (e.props.scroll?.bodyRows ?? 20) - 8)
    const recent = turnViews.slice(-maxBars)
    const maxUsd = Math.max(...recent.map(tv => tv.usd), 0.0001)
    const avg = turnViews.length === 0 ? 0 : turnViews.reduce((a, tv) => a + tv.usd, 0) / turnViews.length
    const priciestTurn = turnViews.reduce<TurnView | null>((a, tv) => (a === null || tv.usd > a.usd ? tv : a), null)
    const barCols = Math.max(6, cols - 22)
    const chartW = Math.min(1400, Math.max(480, Math.round(cols * 8)))
    const chartH = Math.min(460, Math.max(280, Math.round(chartW * 0.45)))
    const mode = await read($, chartMode)
    const pickedTurn = await read($, selectedTurn)
    const shownTurn = turnViews.find(tv => tv.n === pickedTurn) ?? null
    const series = seriesFor(mode)
    const turnDetail = shownTurn && (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="subtle" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            Turn #{shownTurn.n}
            {shownTurn.isOpen ? ' (running)' : ''} · {usd(shownTurn.usd)} · {pct(shownTurn.usd, shown)} of session
          </Text>
          <Button key="turn-close" plain dimColor label="Close" onPress={() => update($, selectedTurn, () => null)} />
        </Box>
        {shownTurn.prompt && <Text dimColor wrap="truncate-end">“{shownTurn.prompt}”</Text>}
        <Row label="Main thread" cost={usd(shownTurn.source.main)} share={pct(shownTurn.source.main, shownTurn.usd)} />
        <Row label="Subagents" tokens={`${shownTurn.byAgent.length}`} cost={usd(shownTurn.source.subagents)} share={pct(shownTurn.source.subagents, shownTurn.usd)} />
        {shownTurn.byAgent.map(a => (
          <Row label={`${a.label}`} indent tokens={a.models.join(',').slice(0, W_TOK - 1)} cost={usd(a.usd)} share={pct(a.usd, shownTurn.usd)} dim />
        ))}
        <Row label="Web search" cost={usd(shownTurn.source.search)} share={pct(shownTurn.source.search, shownTurn.usd)} />
        <Row label="Other" cost={usd(shownTurn.source.other)} share={pct(shownTurn.source.other, shownTurn.usd)} dim />
        <Text> </Text>
        {CATEGORY_SERIES.filter(s => s.key !== 'search' && s.key !== 'other').map(s => (
          <Row label={s.label} swatch={s.color} cost={usd(shownTurn.parts[s.key])} share={pct(shownTurn.parts[s.key], shownTurn.usd)} dim />
        ))}
        {shownTurn.byModel.map(m => (
          <Row label={shortModel(m.model)} cost={usd(m.usd)} share={pct(m.usd, shownTurn.usd)} dim />
        ))}
      </Box>
    )
    const turnsView = (
      <Box flexDirection="column">
        {recent.length === 0 && <Text dimColor>No turns yet: the chart fills from the next prompt.</Text>}
        {recent.length > 0 && (
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>
              {turnViews.length} turns · avg {usd(avg)}
              {priciestTurn ? ` · max #${priciestTurn.n} ${usd(priciestTurn.usd)}` : ''}
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button
                key="mode-source"
                label="Main / Subagents"
                variant={mode === 'source' ? 'primary' : undefined}
                dimColor={mode === 'source' ? undefined : true}
                onPress={() => update($, chartMode, () => 'source' as const)}
              />
              <Button
                key="mode-category"
                label="Token types"
                variant={mode === 'category' ? 'primary' : undefined}
                dimColor={mode === 'category' ? undefined : true}
                onPress={() => update($, chartMode, () => 'category' as const)}
              />
            </Box>
          </Box>
        )}
        {recent.length > 0 && Svg && (
          <Svg
            // The hover frame is 300x150 unless sized: give it the pane's width (about
            // 8px a column) and a height to match, drawn 1:1 so text stays readable.
            source={chartSvg(recent, chartW, chartH, mode)}
            width={chartW}
            height={chartH}
            alt={`Cost per turn for the last ${recent.length} turns, highest ${usd(maxUsd)}`}
            isInteractive
          />
        )}
        {recent.length > 0 &&
          !Svg &&
          recent.map(tv => {
            const values = valuesFor(tv, mode)
            const cells = Math.max(1, Math.round((tv.usd / maxUsd) * barCols))
            let used = 0
            return (
              <Box flexDirection="row">
                <Box width={5}>
                  <Text dimColor>#{tv.n}</Text>
                </Box>
                <Box width={barCols}>
                  <Text>
                    {series.map(s => {
                      const n = Math.min(cells - used, Math.round(((values[s.key] ?? 0) / Math.max(tv.usd, 1e-9)) * cells))
                      used += Math.max(0, n)
                      return n > 0 ? <Text color={s.color}>{'█'.repeat(n)}</Text> : ''
                    })}
                  </Text>
                </Box>
                <Text> {usd(tv.usd)}</Text>
              </Box>
            )
          })}
        {recent.length > 0 && <Heading text="Recent turns" hint="press one for its breakdown" />}
        {[...recent]
          .reverse()
          .slice(0, 10)
          .map(tv => (
            <Box flexDirection="row">
              <Button
                key={`turn-${tv.n}`}
                plain
                dimColor={pickedTurn === tv.n ? undefined : true}
                label={`#${tv.n}`}
                onPress={() => update($, selectedTurn, v => (v === tv.n ? null : tv.n))}
              />
              <Row
                label={` ${tv.prompt}`}
                tokens={tv.byAgent.length > 0 ? `${tv.byAgent.length}· ${usd(tv.source.subagents)}` : ''}
                cost={tv.isOpen ? `${usd(tv.usd)}…` : usd(tv.usd)}
                share={pct(tv.usd, shown)}
              />
            </Box>
          ))}
        {turnDetail}
      </Box>
    )

    // --- Usage: this machine's share of the plan's windows ----------------------
    const ul = await read($, usage)
    const pooled = mergeSpend(ul.others, ul.spend)
    const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const MINE = '#5B8DEF'
    const REST = '#9AA0A6'
    const FREE = '#4a4d52'
    /** 8940000 ms -> "2h 29m"; a day or more -> "6d 4h". */
    const span = (ms: number) => {
      const m = Math.max(0, Math.floor(ms / 60_000))
      const d = Math.floor(m / 1440)
      const h = Math.floor((m % 1440) / 60)
      return d > 0 ? `${d}d ${h}h` : `${h}h ${two(m % 60)}m`
    }
    const windowView = (kind: RateKind, title: string) => {
      const r = ul.readings[kind]
      if (!r) return null
      const resetAt = Date.parse(r.resetsAt)
      if (!(resetAt > t)) return <Heading text={title} hint="reset, waiting for the next response" />
      const start = windowStart(kind, r.resetsAt)
      const spent = spendBetween(pooled, start, t + 60_000)
      const calibration = ul.calibration[kind]
      const k = factor(calibration)
      const mine = share(spent, k, r.percent)
      const bars =
        kind === 'five_hour'
          ? hourBars(pooled, start, t).map((v, i) => ({ label: `+${i}h`, usd: v }))
          : dayBars(pooled, start, t).map(d => {
              const day = new Date(d.start)
              return { label: `${WEEKDAY[day.getDay()] ?? ''} ${day.getDate()}${d.partial ? '·' : ''}`, usd: d.usd }
            })
      const top = Math.max(...bars.map(b => b.usd), 1e-9)
      const W_BARLABEL = 7
      const W_BARVALUE = 18
      const barCells = Math.max(6, cols - W_BARLABEL - W_BARVALUE)
      return (
        <Box flexDirection="column">
          <Heading text={title} hint={`resets in ${span(resetAt - t)}`} />
          <Split
            cells={Math.max(8, cols - 2)}
            parts={[
              { value: mine ?? 0, color: MINE },
              { value: Math.max(0, r.percent - (mine ?? 0)), color: REST },
              { value: Math.max(0, 100 - r.percent), color: FREE },
            ]}
            alt={`Account ${r.percent.toFixed(1)}% used`}
          />
          <Row label="Account" cost={`${r.percent.toFixed(1)}%`} />
          <Row label="This machine" tokens={usd(spent)} cost={mine === null ? '—' : `~${mine.toFixed(1)}%`} bold />
          {mine === null && (
            <Text dimColor>
              {calibration.n < 8
                ? `calibrating: ${calibration.n} of 8 pairs seen`
                : 'calibrating: the window has barely moved yet'}
            </Text>
          )}
          {bars.map(b => {
            // Each bar's share of the machine's whole, so the bars add up to it and to no more.
            const part = mine === null || spent <= 0 ? null : b.usd * (mine / spent)
            return (
              <Box key={`bar-${kind}-${b.label}`} flexDirection="row">
                <Box width={W_BARLABEL}>
                  <Text dimColor>{b.label}</Text>
                </Box>
                <Split
                  cells={barCells}
                  parts={[
                    { value: b.usd, color: MINE },
                    { value: top - b.usd, color: FREE },
                  ]}
                  alt={`${b.label} ${usd(b.usd)}`}
                />
                <Box width={W_BARVALUE} justifyContent="flex-end">
                  <Text dimColor>{b.usd === 0 ? '' : part === null ? usd(b.usd) : `~${part.toFixed(1)}%  ${usd(b.usd)}`}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }
    const fiveHour = windowView('five_hour', '5-hour window')
    const sevenDay = windowView('seven_day', 'Week')
    const usageView = (
      <Box flexDirection="column">
        {fiveHour === null && sevenDay === null && <Text dimColor>No subscription usage reported yet.</Text>}
        {fiveHour}
        {sevenDay}
        {(fiveHour !== null || sevenDay !== null) && (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text color={MINE}>■</Text>
              <Text dimColor> this machine  </Text>
              <Text color={REST}>■</Text>
              <Text dimColor> the rest of the account</Text>
            </Text>
            <Text dimColor>
              The machine's share is an estimate: its own spend at list price times the account points
              per dollar learned from its back-to-back responses. The week runs from its reset, in local days; a · marks a partial day.
            </Text>
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        <Box marginTop={1}>{tabs}</Box>
        <Text> </Text>
        {current === 'summary' && summary}
        {current === 'models' && modelsView}
        {current === 'agents' && (page ? agentPage(page) : agentsList)}
        {current === 'turns' && turnsView}
        {current === 'usage' && usageView}
        <Text> </Text>
        <Text dimColor>
          List prices, cache writes at the 5-minute rate. "Other" is the /cost total minus the lines
          itemized here: WebSearch's own model call, 1-hour cache writes, fast mode, compaction, and
          spend from before the mod loaded.
          {unpriced.length > 0 ? ` No price for: ${unpriced.join(', ')}.` : ''}
        </Text>
        <Box flexDirection="row">
          <Button key="reset" plain dimColor label="Reset breakdown" onPress={() => update($, ledger, () => EMPTY)} />
        </Box>
      </Box>
    )
  })
}
