import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, ChartMode, ContextFill, Ledger, Live, ModelRow, Tab, Tokens, TurnAgentRow, TurnRow } from '../types'

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
  shape: 'agents-1',
})
// The main thread's prompt cache is taken to live an hour after its last response.
const CACHE_TTL_MS = 60 * 60_000
const now = atom({ plugin: 'session-cost', key: 'now' } as const, 0)

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
// Engine calls (top-level so the engine can follow `$`).
// ---------------------------------------------------------------------------
async function refreshTotal($: EngineInterface) {
  const usage = await $.session.usage()
  const value = usage.cost?.usd ?? null
  await update($, total, () => value)
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


let ticker: { cancel: () => void } | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // No status line: the engine labels it with the mod's name and it takes no click.
    // This clears one an earlier version pinned.
    $.ui.status(undefined)
    await refreshTotal($)
    await refreshContext($)
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
    }

    return ran
  })

  // Every model response, main thread and subagents: its token counts.
  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const begun = isMain ? await $.clock.now() : 0
    let first: number | null = null
    // The live rate, while the response streams: the characters that arrived (text,
    // visible thinking, tool arguments) at about four to a token, over the real time
    // since the first piece, written at most once a second.
    let chars = 0
    let wallStart = 0
    let lastWrite = 0
    const stream = next(e)
    for await (const chunk of stream) {
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
    if (isMain) {
      // Output tokens over the time from the first streamed piece to the end.
      const end = await $.clock.now()
      const ms = Math.max(1, end - (first ?? begun))
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
    const agentId = e.agentId
    let meta: { type: string; description: string } | null = null
    if (agentId !== undefined && u !== null) {
      const known = (await read($, agentCosts))[agentId]
      const found = known ?? (await describeAgent($, agentId))
      meta = { type: found.type, description: found.description }
      const m = meta
      const turnNo = (await read($, ledger)).turnCount
      await update($, agentCosts, all => {
        const prev: AgentRow = all[agentId] ?? {
          id: agentId,
          type: m.type,
          description: m.description,
          requests: 0,
          models: {},
          webSearches: 0,
          turn: turnNo,
        }
        return { ...all, [agentId]: { ...prev, requests: prev.requests + 1, models: addUsage(prev.models, u.model, u) } }
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

    return r
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
    const cacheValue = cacheLeft === null ? '—' : cacheLeft <= 0 ? 'expired' : dur(cacheLeft)
    const chips: Chip[] = [
      {
        // The current turn: running or idle, and for how long.
        text: `● #${turnNo} ${elapsed === null ? '' : dur(elapsed)}`,
        keep: 98,
        node: (
          <Text>
            <Text color={lv.isRunning ? 'green' : 'gray'}>{lv.isRunning ? '●' : '○'}</Text>
            <Text bold>{` #${turnNo}`}</Text>
            <Text dimColor>{elapsed === null ? '' : ` ${dur(elapsed)}`}</Text>
          </Text>
        ),
      },
      {
        // Cost, one group: this turn (yellow) | the session as /cost totals it (green).
        text: `💰  ${money(turnUsd)} | ${money(value)}`,
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
        text: `🧠  ${'━'.repeat(CTX_BAR)} ${ctxLabel}`,
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
        text: `⏳  ${cacheValue}`,
        keep: 80,
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
        text: `⚡  ${tps === null ? '—' : Math.round(tps)}/s`,
        keep: 85,
        node: (
          <Text>
            <Text>⚡ </Text>
            <Text color="cyan" bold={lv.streamingSince !== null}>
              {tps === null ? '—' : String(Math.round(tps))}
            </Text>
            <Text dimColor>/s</Text>
          </Text>
        ),
      },
      {
        // Wall-clock time: always shown, however narrow the row.
        text: `🕒  ${clock(t)}`,
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
    // Two cells between groups: apart enough to read as groups, close enough to scan.
    const GAP = '  '
    const room = e.props.bodyColumns - 6
    const kept = [...chips]
    const width = (list: Chip[]) =>
      list.reduce((a, c) => a + c.text.length, 0) + Math.max(0, list.length - 1) * GAP.length
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
    const agentRows = Object.values(await read($, agentCosts))
    const listed = await $.agent.list()
    const agentView = agentRows
      .map(a => {
        const priced = priceRows(a.models)
        const cost = sumCost(priced.cost) + a.webSearches * WEB_SEARCH_USD
        const tokens = Object.values(a.models).reduce(
          (n, m) => n + m.input + m.output + m.cacheRead + m.cacheWrite,
          0,
        )
        const status = listed.find(x => x.id === a.id)?.status ?? 'done'
        return { ...a, cost, tokens, status }
      })
      .sort((x, y) => y.cost - x.cost)
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
    const totalTokens = toks.input + toks.output + toks.cacheRead + toks.cacheWrite
    const inputSide = toks.input + toks.cacheRead + toks.cacheWrite
    const hitRate = inputSide === 0 ? null : (toks.cacheRead / inputSide) * 100
    const requests = rows.reduce((a, r) => a + r.requests, 0)

    const cols = e.props.bodyColumns
    const narrow = cols < 46
    const W_LABEL = narrow ? 13 : 16
    const W_TOK = narrow ? 8 : 10
    const W_USD = 10
    const W_PCT = narrow ? 0 : 5

    const Row = (p: { label: string; tokens?: string; cost: string; share?: string; dim?: boolean; bold?: boolean; indent?: boolean }) => (
      <Box flexDirection="row">
        <Box width={W_LABEL}>
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

    const tabs = (
      <Box flexDirection="row" gap={1}>
        {(
          [
            ['summary', 'Summary', '1'],
            ['models', 'Models', '2'],
            ['agents', 'Agents', '3'],
            ['turns', 'Turns', '4'],
          ] as const
        ).map(([id, label, hotkey]) => (
          <Button
            key={`tab-${id}`}
            label={current === id ? `● ${label}` : label}
            hotkey={hotkey}
            onPress={() => update($, tab, () => id)}
          />
        ))}
      </Box>
    )

    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>Total </Text>
          <Text bold color="green">{usd(shown)}</Text>
          <Text dimColor>{engineTotal === null ? '  (estimate)' : '  (as /cost)'}</Text>
        </Box>
        <Text dimColor>
          {tok(totalTokens)} tokens · {requests} requests
          {l.subagentRequests > 0 ? ` (${l.subagentRequests} subagent)` : ''}
          {hitRate === null ? '' : ` · cache hit ${hitRate.toFixed(0)}%`}
        </Text>
      </Box>
    )

    // --- Summary -----------------------------------------------------------
    const summary = (
      <Box flexDirection="column">
        <Row label="Item" tokens="Tokens" cost="USD" share="%" dim />
        <Row label="Input" tokens={tok(toks.input)} cost={usd(sum.input)} share={pct(sum.input, shown)} />
        <Row label="Output" tokens={tok(toks.output)} cost={usd(sum.output)} share={pct(sum.output, shown)} />
        <Row label="Cache write" tokens={tok(toks.cacheWrite)} cost={usd(sum.cacheWrite)} share={pct(sum.cacheWrite, shown)} />
        <Row label="Cache read" tokens={tok(toks.cacheRead)} cost={usd(sum.cacheRead)} share={pct(sum.cacheRead, shown)} />
        <Row label="Web search" tokens={`${searchCount}x`} cost={usd(searchUsd)} share={pct(searchUsd, shown)} />
        {agentView.length > 0 && (
          <Row
            label="↳ Subagents"
            tokens={`${agentView.length} agents`}
            cost={usd(subUsd)}
            share={pct(subUsd, shown)}
            dim
          />
        )}
        {l.webFetches > 0 && <Row label="Web fetch" tokens={`${l.webFetches}x`} cost="tokens" dim />}
        {Object.entries(l.serverTools)
          .filter(([name]) => name !== 'web_search')
          .map(([name, n]) => (
            <Row label={name} tokens={`${n}x`} cost="tokens" dim />
          ))}
        {other !== null && Math.abs(other) >= 0.00005 && (
          <Row label="Other" cost={usd(other)} share={pct(other, shown)} dim />
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
              <Row
                label={shortModel(row.model)}
                tokens={`${row.requests} req`}
                cost={subtotal === null ? '?' : usd(subtotal)}
                share={subtotal === null ? '' : pct(subtotal, shown)}
                bold
              />
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

    // --- Agents ------------------------------------------------------------
    const mainUsd = computed - subUsd
    const priciestAgent = agentView[0]
    const agentsView = (
      <Box flexDirection="column">
        {agentView.length === 0 && <Text dimColor>No subagent has run since the mod loaded.</Text>}
        {agentView.length > 0 && (
          <Text dimColor>
            {agentView.length} subagents · {usd(subUsd)} in all · avg {usd(subUsd / agentView.length)}
            {priciestAgent ? ` · max ${priciestAgent.type} ${usd(priciestAgent.cost)}` : ''}
          </Text>
        )}
        {agentView.length > 0 && <Text> </Text>}
        <Row label="Item" tokens="Tokens" cost="USD" share="%" dim />
        <Row label="Main thread" tokens="" cost={usd(Math.max(0, mainUsd))} share={pct(mainUsd, shown)} bold />
        <Row label="Subagents" tokens={tok(agentView.reduce((n, a) => n + a.tokens, 0))} cost={usd(subUsd)} share={pct(subUsd, shown)} bold />
        {agentView.map(a => (
          <Box flexDirection="column" marginTop={1}>
            <Row
              label={`${a.status === 'running' || a.status === 'pending' || a.status === 'waiting' ? '● ' : ''}${a.type}`}
              tokens={tok(a.tokens)}
              cost={usd(a.cost)}
              share={pct(a.cost, shown)}
            />
            <Text dimColor wrap="truncate-end">
              {`  ${a.description} · ${a.status} · turn #${a.turn} · ${a.requests} req`}
              {a.webSearches > 0 ? ` · ${a.webSearches} searches` : ''}
            </Text>
            {Object.values(a.models).map(m => {
              const c = costOf(m)
              return (
                <Row
                  label={shortModel(m.model)}
                  indent
                  tokens={tok(m.input + m.output + m.cacheRead + m.cacheWrite)}
                  cost={c === null ? '?' : usd(sumCost(c))}
                  dim
                />
              )
            })}
          </Box>
        ))}
      </Box>
    )

    // --- Turns -------------------------------------------------------------
    const turnViews = l.turns.map(t => viewTurn(t, engineTotal))
    const maxBars = Svg ? 40 : Math.max(5, (e.props.scroll?.bodyRows ?? 20) - 8)
    const recent = turnViews.slice(-maxBars)
    const maxUsd = Math.max(...recent.map(t => t.usd), 0.0001)
    const avg = turnViews.length === 0 ? 0 : turnViews.reduce((a, t) => a + t.usd, 0) / turnViews.length
    const priciest = turnViews.reduce<TurnView | null>((a, t) => (a === null || t.usd > a.usd ? t : a), null)
    const barCols = Math.max(6, cols - 22)
    const chartW = Math.min(1400, Math.max(480, Math.round(cols * 8)))
    const chartH = Math.min(460, Math.max(280, Math.round(chartW * 0.45)))
    const mode = await read($, chartMode)
    const picked = await read($, selectedTurn)
    const shownTurn = turnViews.find(t => t.n === picked) ?? null
    const series = seriesFor(mode)
    const turnDetail = shownTurn && (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            Turn #{shownTurn.n}
            {shownTurn.isOpen ? ' (running)' : ''} · {usd(shownTurn.usd)} · {pct(shownTurn.usd, shown)} of session
          </Text>
          <Button key="turn-close" label="Close" onPress={() => update($, selectedTurn, () => null)} />
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
          <Row label={s.label} cost={usd(shownTurn.parts[s.key])} share={pct(shownTurn.parts[s.key], shownTurn.usd)} dim />
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
              {priciest ? ` · max #${priciest.n} ${usd(priciest.usd)}` : ''}
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button
                key="mode-source"
                label={mode === 'source' ? '● Main / Subagents' : 'Main / Subagents'}
                onPress={() => update($, chartMode, () => 'source' as const)}
              />
              <Button
                key="mode-category"
                label={mode === 'category' ? '● Token types' : 'Token types'}
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
          recent.map(t => {
            const values = valuesFor(t, mode)
            const cells = Math.max(1, Math.round((t.usd / maxUsd) * barCols))
            let used = 0
            return (
              <Box flexDirection="row">
                <Box width={5}>
                  <Text dimColor>#{t.n}</Text>
                </Box>
                <Box width={barCols}>
                  <Text>
                    {series.map(s => {
                      const n = Math.min(cells - used, Math.round(((values[s.key] ?? 0) / Math.max(t.usd, 1e-9)) * cells))
                      used += Math.max(0, n)
                      return n > 0 ? <Text color={s.color}>{'█'.repeat(n)}</Text> : ''
                    })}
                  </Text>
                </Box>
                <Text> {usd(t.usd)}</Text>
              </Box>
            )
          })}
        {recent.length > 0 && <Text> </Text>}
        {recent.length > 0 && <Text dimColor>Press a turn for its breakdown.</Text>}
        {recent.length > 0 && <Row label="Turn" tokens="Subagents" cost="USD" dim />}
        {[...recent]
          .reverse()
          .slice(0, 10)
          .map(t => (
            <Box flexDirection="row">
              <Button
                key={`turn-${t.n}`}
                label={picked === t.n ? `● #${t.n}` : `#${t.n}`}
                onPress={() => update($, selectedTurn, v => (v === t.n ? null : t.n))}
              />
              <Row
                label={` ${t.prompt}`}
                tokens={t.byAgent.length > 0 ? `${t.byAgent.length}· ${usd(t.source.subagents)}` : ''}
                cost={t.isOpen ? `${usd(t.usd)}…` : usd(t.usd)}
                share={pct(t.usd, shown)}
              />
            </Box>
          ))}
        {turnDetail}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        {tabs}
        <Text> </Text>
        {current === 'summary' && summary}
        {current === 'models' && modelsView}
        {current === 'agents' && agentsView}
        {current === 'turns' && turnsView}
        <Text> </Text>
        <Text dimColor>
          List prices; cache write at the 5m rate (1.25x). "Other" = the /cost total
          minus the lines above (WebSearch's own model call, 1h cache writes, fast
          mode, compaction, cost before this mod loaded).
          {unpriced.length > 0 ? ` No price for: ${unpriced.join(', ')}.` : ''}
        </Text>
        <Box flexDirection="row">
          <Button key="reset" label="Reset breakdown" onPress={() => update($, ledger, () => EMPTY)} />
        </Box>
      </Box>
    )
  })
}
