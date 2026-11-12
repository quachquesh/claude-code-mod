export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type ModelRow = Tokens & {
  model: string
  requests: number
}

/** One main-thread turn (a prompt and everything it ran, subagents included). */
export type TurnRow = {
  /** 1-based turn number in this session (since the mod loaded). */
  n: number
  turnId: string
  /** The prompt's first characters. */
  prompt: string
  /** Still running. */
  isOpen: boolean
  /** The engine's session total when the turn started; null where none. */
  totalBefore: number | null
  /** The engine's session total when the turn ended (or last measured). */
  totalAfter: number | null
  /** Token counts per model id, summed over the turn's responses. */
  models: Record<string, ModelRow>
  /** Searches the WebSearch tool ran in the turn. */
  webSearches: number
  /** What each subagent spent in the turn, by its loop's id (absent on older rows). */
  agents?: Record<string, TurnAgentRow>
}

/** One subagent's share of a turn. */
export type TurnAgentRow = {
  type: string
  description: string
  models: Record<string, ModelRow>
  webSearches: number
}

export type Ledger = {
  /** Token counts per model id, summed over every response (main thread and subagents). */
  models: Record<string, ModelRow>
  /** Searches run by the WebSearch tool (searchCount of each call). */
  webSearches: number
  /** Calls of the WebFetch tool (no per-call fee, only tokens). */
  webFetches: number
  /** Server tools the API ran inside a response, by name. */
  serverTools: Record<string, number>
  /** Responses made in subagents. */
  subagentRequests: number
  /** The last turns, oldest first (at most 60). */
  turns: TurnRow[]
  /** Turns seen in all, numbering the next one. */
  turnCount: number
}

/** What one subagent (or an engine fork) has cost, by its loop's id. */
export type AgentRow = {
  id: string
  /** Its agent type (`Explore`, `general-purpose`, ...), or `fork` for the engine's own. */
  type: string
  /** The Agent call's short description of its task. */
  description: string
  requests: number
  models: Record<string, ModelRow>
  /** Searches its WebSearch calls ran. */
  webSearches: number
  /** The main turn it first answered in. */
  turn: number
}

export type Tab = 'summary' | 'models' | 'agents' | 'turns'

/** What the turns chart stacks: who spent it, or which tokens. */
export type ChartMode = 'source' | 'category'

/** What the band above the prompt shows live, in `$.clock.now()` milliseconds. */
export type Live = {
  /** The main turn running now, or the last one. */
  turnStartedAt: number | null
  turnEndedAt: number | null
  isRunning: boolean
  /** When the main thread's current response started streaming; null between responses. */
  streamingSince: number | null
  /** Output tokens per second of the main thread's last response. */
  lastTps: number | null
  /** Output tokens and generation time summed over the current turn's main responses. */
  turnOutput: number
  turnGenMs: number
  /** When the main thread's last response ended: the prompt cache's clock starts there. */
  lastResponseAt: number | null
}

/** The context window's fill as /context measures it: against the compaction window. */
export type ContextFill = {
  tokens: number | null
  /** The window measured against: the model's limit or a smaller compaction window. */
  window: number
  percent: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-cost': {
      ledger: Shaped<Ledger>
      total: number | null
      tab: Tab
      live: Shaped<Live>
      agents: Shaped<Record<string, AgentRow>>
      chartMode: ChartMode
      context: ContextFill | null
      /** The turn whose breakdown the Turns tab shows; null for none. */
      selectedTurn: number | null
      /** The clock the band redraws by, ticked every second. */
      now: number
    }
  }
}
