import type { Calibration, RateKind, Reading } from '../types'

// Pure logic of the usage panel: spend buckets, calibration, estimates. No `$` here.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long a minute bucket is kept. */
const KEEP_MS = 8 * DAY
/** Two responses count as a pair for calibration when at most this far apart. */
const PAIR_MS = 30_000
/** Pairs needed, and the account points they must add up to, before a factor is trusted. */
const MIN_PAIRS = 8
const MIN_POINTS = 1
/** Older calibration sums count a little less with each new pair. */
const DECAY = 0.99

const SPAN: Record<RateKind, number> = { five_hour: 5 * HOUR, seven_day: 7 * DAY }

const minuteKey = (ms: number) => String(Math.floor(ms / MINUTE))

/** A window's identity: its reset time in minutes since the epoch. */
export const windowId = (resetsAt: string): number => Math.round(Date.parse(resetsAt) / MINUTE)

/** When the window began, in epoch milliseconds. */
export const windowStart = (kind: RateKind, resetsAt: string): number => Date.parse(resetsAt) - SPAN[kind]

/** Adds a cost to the bucket of the minute `at` falls in; a cost that is not a number is 0. */
export const addSpend = (spend: Record<string, number>, at: number, usd: number): Record<string, number> => {
  const key = minuteKey(at)
  return { ...spend, [key]: (spend[key] ?? 0) + (Number.isFinite(usd) ? usd : 0) }
}

/** The buckets from the last eight days. */
export const pruneSpend = (spend: Record<string, number>, now: number): Record<string, number> => {
  const oldest = Math.floor((now - KEEP_MS) / MINUTE)
  return Object.fromEntries(Object.entries(spend).filter(([key]) => Number(key) >= oldest))
}

/** Spend in the minutes that start in [from, to). */
export const spendBetween = (spend: Record<string, number>, from: number, to: number): number => {
  let total = 0
  for (const [key, usd] of Object.entries(spend)) {
    const at = Number(key) * MINUTE
    if (at >= from && at < to) total += usd
  }
  return total
}

/** Two sets of buckets as one, minute by minute. */
export const mergeSpend = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
  const out = { ...a }
  for (const [key, usd] of Object.entries(b)) out[key] = (out[key] ?? 0) + usd
  return out
}

/** Whether `next` and the reading before it make a calibration pair. */
export const qualifies = (prev: Reading | undefined, next: Reading): boolean =>
  prev !== undefined &&
  windowId(prev.resetsAt) === windowId(next.resetsAt) &&
  next.at - prev.at >= 0 &&
  next.at - prev.at <= PAIR_MS &&
  next.percent >= prev.percent

/** Folds one pair (the points the account rose, the dollars the response cost) into the sums. */
export const learn = (c: Calibration, dPct: number, usd: number): Calibration => ({
  dPct: c.dPct * DECAY + dPct,
  usd: c.usd * DECAY + usd,
  n: c.n + 1,
})

/** Account points per dollar of this machine's spend, once enough has been seen. */
export const factor = (c: Calibration): number | null =>
  c.n >= MIN_PAIRS && c.dPct >= MIN_POINTS && c.usd > 0 ? c.dPct / c.usd : null

/** This machine's estimated points: spend times the factor, never above the account's own. */
export const share = (usd: number, k: number | null, accountPct: number): number | null =>
  k === null ? null : Math.min(usd * k, accountPct)

/** Spend in each of the five hours from the window's start. */
export const hourBars = (spend: Record<string, number>, from: number, now: number): number[] =>
  [0, 1, 2, 3, 4].map(i =>
    spendBetween(spend, from + i * HOUR, Math.min(from + (i + 1) * HOUR, now + MINUTE)),
  )

/** Spend on each local calendar date from `from` to `now`, the first and last dates partial. */
export const dayBars = (
  spend: Record<string, number>,
  from: number,
  now: number,
): Array<{ start: number; usd: number }> => {
  const out: Array<{ start: number; usd: number }> = []
  const first = new Date(from)
  let day = new Date(first.getFullYear(), first.getMonth(), first.getDate())
  while (day.getTime() <= now && out.length < 9) {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
    out.push({
      start: day.getTime(),
      usd: spendBetween(spend, Math.max(day.getTime(), from), Math.min(next.getTime(), now + MINUTE)),
    })
    day = next
  }
  return out
}
