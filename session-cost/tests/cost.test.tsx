import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'session-cost',
  component: 'Pane',
  requestId: 'session-cost',
  props: {
    title: 'Session cost',
    isFocused: false,
    bodyColumns: 52,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const USAGE = {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write (1.25x).
  'claude-opus-5-5': {
    input_tokens: 1_000_000,
    output_tokens: 100_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 200_000,
  },
  // Haiku 5.5: $0.10 in, $0.50 out.
  'claude-haiku-5-5': {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
} as const

let engineTotal = 0

/** The engine beneath the plugin, answering each event. */
// 2026-11-12 20:30:00 local time (UTC+7 here).
const START = new Date(2026, 10, 12, 20, 30, 0).getTime()

const engine = (on: On, onOpen: () => void = () => {}, onStatus: (text: string | undefined) => void = () => {}) => {
  const clk = mock.clock(on, { now: START })
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: 'explore', type: 'Explore', status: 'running' },
      { id: 'a2', description: 'done one', type: 'Explore', status: 'completed' },
      { id: 'agent-1', description: 'research', type: 'general-purpose', status: 'completed' },
    ] as never,
  }))
  on('ui.open', () => {
    onOpen()
    return { value: { isPlaced: true } }
  })
  on('ui.status', (_, e) => {
    onStatus(e.text)
    return { value: {} } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The model's window is 1M at 41%; /context measures against the 600K compaction
  // window, 414K = 69%, which is what the band must show.
  on('session.usage', (_, e) => ({
    value: {
      startedAt: 0,
      context: {
        window: 1_000_000,
        tokens: 410_000,
        percent: 41,
        ...(e.breakdown
          ? { breakdown: { totalTokens: 414_000, maxTokens: 600_000, rawMaxTokens: 600_000, percentage: 69 } as never }
          : {}),
      },
      rateLimits: [],
      cost: { usd: engineTotal },
    },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    const model = e.model as keyof typeof USAGE
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model, ...USAGE[model] },
    }
  })
  on('tool.call', () => ({ result: { query: 'q', results: [], durationSeconds: 1, searchCount: 2 } }))
  on('session.measure', (_, e) => ({ changed: e.changed, cwd: '/' }))
  return clk
}

const step = async ($: Engine, turnId: string, model: string, agentId?: string) => {
  const s = $.turn.step({ turnId, index: 0, model, messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of s) {
    // drain
  }
  await s.result
}

/** Two turns: #1 Opus + 2 searches (engine says $12), #2 a Haiku subagent ($0.60). */
const play = async ($: Engine) => {
  engineTotal = 0
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { window: 1 } as never, rateLimits: [], cost: { usd: 0 }, changed: ['cost'] })

  await $.turn.start({ turnId: 't1', text: 'first prompt' })
  await step($, 't1', 'claude-opus-5-5')
  await $.tool.call({ tool: 'WebSearch', query: 'q', mode: 'standard' })
  engineTotal = 12
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'completed' } as never)

  await $.turn.start({ turnId: 't2', text: 'second prompt' })
  await step($, 'sub-turn', 'claude-haiku-5-5', 'agent-1')
  engineTotal = 12.6
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: false, reason: 'completed' } as never)
}

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<Array<{ text: string }>> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text)

test('summary itemizes tokens, web search and the remainder', async ($, on) => {
  engine(on)
  await play($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = await texts(ui)
  // Opus: in $4, out $2, read $0.20, write $1; Haiku: in $0.10, out $0.50; 2 searches $0.02.
  expect(all).toContain('$12.60') // engine total
  expect(all).toContain('$4.10') // input
  expect(all).toContain('$2.50') // output
  expect(all).toContain('$0.2000') // cache read
  expect(all).toContain('$1.00') // cache write
  expect(all).toContain('2x') // searches
  expect(all).toContain('$4.78') // other = 12.60 - 7.82
  await ui.unmount()
})

test('models tab splits each model into input, output and cache', async ($, on) => {
  engine(on)
  await play($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-models' })
  const all = await texts(ui)
  expect(all).toContain('opus-5-5')
  expect(all).toContain('haiku-5-5')
  expect(all).toContain('$7.20') // opus subtotal
  expect(all).toContain('$0.6000') // haiku subtotal
  expect(all).toContain('$0.5000') // haiku output
  await ui.unmount()
})

test('turns tab charts each turn from the engine total', async ($, on) => {
  engine(on)
  await play($)

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desktop.press({ key: 'tab-turns' })
  const svg = await desktop.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  // Sized, so the hover frame is not its 300x150 default.
  expect(svg?.props.width).toBeGreaterThanOrEqual(480)
  expect(svg?.props.height).toBeGreaterThanOrEqual(280)
  const all = await texts(desktop)
  expect(all).toContain(' first prompt')
  expect(all).toContain('$12.00') // turn 1 = 12 - 0
  expect(all).toContain('$0.6000') // turn 2 = 12.60 - 12, the subagent's Haiku
  await desktop.unmount()

  // The terminal has no Svg: bars of blocks instead.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const bars = (await texts(term)).filter(t => t.includes('█'))
  expect(bars.length).toBeGreaterThanOrEqual(2)
  await term.unmount()
})

const BAND = {
  plugin: 'session-cost',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

test('the band shows the live figures, the context fill, and opens the pane', async ($, on) => {
  let opened = 0
  const statuses: Array<string | undefined> = []
  const clk = engine(
    on,
    () => {
      opened += 1
    },
    text => statuses.push(text),
  )
  await play($)
  // 70 seconds after the last response: the 1-hour cache has 58:50 left.
  await clk.advance(70_000)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const line = all.join('\n')
    expect(line).toContain('$0.6000') // turn 2's cost
    expect(line).toContain('$12.60') // session total
    expect(line).toContain('#2')
    expect(line).toContain('58:50') // cache countdown
    expect(line).not.toContain('🤖') // no subagent count
    expect(line).toContain('/s')
    expect(line).toContain('20:31:10') // wall clock, HH:mm:ss
    expect(line).toContain('🧠') // the context line
    expect(line).toContain('69%') // against the compaction window
    expect(line).not.toContain('41%')
    expect(line).not.toContain('📋') // no task line any more
    await ui.press({ key: 'session-cost-open' })
    await ui.unmount()
  }
  expect(opened).toBe(2)
  // Nothing labelled "session-cost" is pinned under the prompt.
  expect(statuses.every(s => s === undefined)).toBe(true)
})

test('the cache countdown turns to an hourglass at 00:00', async ($, on) => {
  const clk = engine(on)
  await play($)
  await clk.advance(61 * 60_000)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(line).toContain('⌛ 00:00')
  await ui.unmount()
})

test('the band keeps its width as the timers tick', async ($, on) => {
  const clk = engine(on)
  await play($)

  const lengths: number[] = []
  for (const wait of [5_000, 8 * 60_000, 50 * 60_000, 10 * 60_000]) {
    await clk.advance(wait)
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const line = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    // Countdown at 59:55, 51:55, 01:55 and then past zero; the figures keep five cells.
    expect(line).toMatch(/\d\d:\d\d/)
    lengths.push(line.replace(/\d{2}:\d{2}:\d{2}/, '').length)
    await ui.unmount()
  }
  expect(new Set(lengths).size).toBe(1)
})

test('when the row is short the cache countdown outlasts the speed and the context bar', async ($, on) => {
  const clk = engine(on)
  await play($)
  await clk.advance(10_000)

  let sawSpeedGone = false
  for (let bodyColumns = 120; bodyColumns >= 24; bodyColumns -= 2) {
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns }, surface: 'desktop' })
    const line = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    const has = (icon: string) => line.includes(icon)
    if (has('⚡')) expect(has('⏳')).toBe(true)
    if (has('🧠')) expect(has('⏳')).toBe(true)
    if (!has('⚡')) sawSpeedGone = true
    await ui.unmount()
  }
  expect(sawSpeedGone).toBe(true)
})

test('the band leads with the turn, drops the words, and always keeps the time', async ($, on) => {
  const clk = engine(on)
  await play($)
  await clk.advance(10_000)

  for (const bodyColumns of [140, 50]) {
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns }, surface: 'desktop' })
    const line = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(line).toContain('20:30:10') // the time, at any width
    expect(line).not.toContain(' total')
    expect(line).not.toMatch(/\$[\d.]+ turn/)
    if (bodyColumns === 140) {
      expect(line.indexOf('#2')).toBeLessThan(line.indexOf('$0.6000'))
      expect(line.indexOf('$0.6000')).toBeLessThan(line.indexOf('$12.60'))
      // Icons lead the groups; the cost group is one icon, turn | total.
      expect(line).not.toContain('│')
      expect(line).not.toContain('💵')
      expect(line).toContain('💰 $0.6000 | $12.60')
    }
    await ui.unmount()
  }
})

test('the agents tab lists each subagent as a card, grouped by status', async ($, on) => {
  engine(on)
  await play($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let line = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(String.fromCharCode(10))
  expect(line).toContain('↳ Subagents')
  expect(line).toContain('1 agents')

  await ui.press({ key: 'tab-agents' })
  line = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(String.fromCharCode(10))
  expect((await ui.find({ type: 'Button', key: 'agent-agent-1' }))?.props.label).toBe('research') // its task names the card
  expect(line).toContain('general-purpose Haiku 5.5') // its type and model
  expect(line).toContain('≈$0.6000') // its cost
  expect(line).toContain('Main thread')
  expect(line).toContain('$7.22') // main = 7.82 - 0.60
  const group = await ui.find({ type: 'Button', key: 'fold-finished' })
  expect(group?.props.label).toBe('▾ Finished · 1')
  expect(await ui.find({ type: 'Button', key: 'agent-agent-1' })).toBeDefined()

  // Folding the group hides its cards.
  await ui.press({ key: 'fold-finished' })
  expect(await ui.find({ type: 'Button', key: 'agent-agent-1' })).toBeUndefined()
  await ui.unmount()
})

test("a subagent's page shows its requests, token costs, tools and task", async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'agent-2' }))
  await play($)
  // A second subagent, spawned with a task, calls tools and answers twice.
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'Find where the  ledger is written.',
    description: 'trace ledger',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
  } as never)
  await $.turn.start({ turnId: 'sub-2', text: 'Find where the ledger is written.', agentId: 'agent-2' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'ledger', agentId: 'agent-2' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'ledger', agentId: 'agent-2' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'agent-2' } as never)
  await step($, 'sub-2', 'claude-opus-5-5', 'agent-2')
  await step($, 'sub-2', 'claude-opus-5-5', 'agent-2')
  await $.turn.complete({ turnId: 'sub-2', agentId: 'agent-2', answer: 'In register.tsx.', durationMs: 5000, isAborted: false, reason: 'completed' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-agents' })
  await ui.press({ key: 'agent-agent-2' })
  const line = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(String.fromCharCode(10))
  expect(line).toContain('trace ledger')
  expect(line).toContain('Explore Opus 5.5')
  expect(line).toContain('≈$14.40') // two Opus responses at $7.20
  expect(line).toContain('Find where the ledger is written.') // the task, whitespace folded
  expect(line).toContain('In register.tsx.') // its answer
  expect(line).toContain('Grep')
  expect(line).toContain('3 calls')
  expect(line).toContain('Cost by token type')
  const strip = (await ui.findAll({ type: 'Svg' })).find(x => x.props.alt === '2 requests, $14.40 in all')
  expect(String(strip?.props.source ?? '')).toContain('Request 2')

  // Back to the list.
  await ui.press({ key: 'agent-back' })
  expect(await ui.find({ type: 'Button', key: 'agent-agent-2' })).toBeDefined()
  await ui.unmount()

  // With an agent's transcript in view, the tab opens on its page.
  const viewing = await $.ui.mount({ ...PANE, props: { ...PANE.props, view: { agentId: 'agent-2' } }, surface: 'terminal' })
  await viewing.press({ key: 'tab-agents' })
  const text = (await viewing.findAll({ type: 'Text' })).map(x => x.text).join(String.fromCharCode(10))
  expect(text).toContain('trace ledger')
  expect(text).toContain('██') // the terminal's sparkline, a cell a request
  expect(text).toContain('$7.20 max')
  await viewing.unmount()
})

test('the chart splits each turn into main thread and subagents, with hover tooltips', async ($, on) => {
  engine(on)
  await play($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-turns' })
  const svg = await ui.find({ type: 'Svg' })
  const source = String(svg?.props.source ?? '')
  // Main / Subagents is the default: turn 2's $0.60 is all subagent.
  expect(source).toContain('Main thread')
  expect(source).toContain('Subagents')
  expect(source).toContain('general-purpose: research (haiku-5-5)')
  // Tooltips are the SVG's own, shown by CSS :hover, not a native <title>.
  expect(source).toContain('.b1:hover~.t1{display:inline}')
  expect(source).not.toContain('<title>')

  // Token types mode stacks by category instead.
  await ui.press({ key: 'mode-category' })
  const byType = String((await ui.find({ type: 'Svg' }))?.props.source ?? '')
  expect(byType).toContain('Cache write')

  // Pressing a turn opens its breakdown, the subagent on its own line.
  await ui.press({ key: 'turn-2' })
  const line = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(String.fromCharCode(10))
  expect(line).toContain('Turn #2')
  expect(line).toContain('general-purpose: research')
  await ui.unmount()
})

test('the band is one row, the context a group in it, and a small icon button', async ($, on) => {
  engine(on)
  await play($)

  for (const bodyColumns of [90, 140]) {
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns }, surface: 'desktop' })
    const root = await ui.find({ type: 'Box' })
    expect(root?.props.flexDirection).toBe('row')
    const line = (await ui.findAll({ type: 'Text' })).map(x => x.text).join(String.fromCharCode(10))
    expect(line).toContain('🧠')
    expect(line).toContain('69%') // against the compaction window
    expect(line).not.toContain('41%')
    expect(line).toContain('20:30:00') // the time stays at any width
    const button = await ui.find({ type: 'Button', key: 'session-cost-open' })
    expect(button?.props.label).toBe('📊')
    await ui.unmount()
  }
})

test('the context bar is a rounded pill on a desktop, a thin line on a terminal', async ($, on) => {
  engine(on)
  await play($)

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const pill = await desk.find({ type: 'Svg' })
  const source = String(pill?.props.source ?? '')
  expect(source).toContain('linearGradient')
  expect(source).toContain('rx="5"')
  expect(pill?.props.alt).toBe('Context 69%')
  await desk.unmount()

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  const line = (await term.findAll({ type: 'Text' })).map(x => x.text).join(String.fromCharCode(10))
  expect(line).toContain('━')
  expect(line).toContain('69%')
  await term.unmount()
})
