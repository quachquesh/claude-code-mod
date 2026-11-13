import { expect, test } from 'claude-code/testing'

import {
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
  windowId,
  windowStart,
} from '../hooks/usage'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const BASE = Date.UTC(2026, 10, 12, 0, 0, 0)
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)

test('addSpend adds spend in the same minute into one bucket', () => {
  const s = addSpend(addSpend({}, BASE + 30_000, 0.5), BASE + 45_000, 0.25)
  expect(Object.keys(s)).toHaveLength(1)
  expect(near(sum(s), 0.75)).toBe(true)
})

test('addSpend stores a non-finite cost as zero', () => {
  const s = addSpend({}, BASE, Number.NaN)
  expect(Number.isFinite(sum(s))).toBe(true)
  expect(sum(s)).toBe(0)
})

test('pruneSpend drops buckets older than 8 days and keeps newer ones', () => {
  const now = BASE + 20 * DAY
  const s = addSpend(addSpend({}, now - 9 * DAY, 1), now - 7 * DAY, 2)
  const kept = pruneSpend(s, now)
  expect(sum(kept)).toBe(2)
})

test('spendBetween sums the minutes in [from, to)', () => {
  const s = addSpend(addSpend(addSpend({}, BASE, 1), BASE + 5 * MIN, 2), BASE + 10 * MIN, 4)
  expect(spendBetween(s, BASE, BASE + 10 * MIN)).toBe(3)
  expect(spendBetween(s, BASE + 5 * MIN, BASE + 11 * MIN)).toBe(6)
})

test('windowId rounds resetsAt to the minute; windowStart is 5h or 7d earlier', () => {
  expect(windowId('2026-11-13T05:00:20Z')).toBe(windowId('2026-11-13T05:00:00Z'))
  expect(windowId('2026-11-13T05:01:00Z')).not.toBe(windowId('2026-11-13T05:00:00Z'))
  const at = Date.parse('2026-11-13T05:00:00Z')
  expect(windowStart('five_hour', '2026-11-13T05:00:00Z')).toBe(at - 5 * HOUR)
  expect(windowStart('seven_day', '2026-11-13T05:00:00Z')).toBe(at - 7 * DAY)
})

test('qualifies accepts a close pair in one window with a rising reading only', () => {
  const prev = { percent: 10, resetsAt: '2026-11-13T05:00:00Z', at: 1_000_000 }
  const next = (over: Partial<typeof prev>) => ({ ...prev, at: prev.at + 20_000, percent: 10.4, ...over })
  expect(qualifies(prev, next({}))).toBe(true)
  expect(qualifies(prev, next({ at: prev.at + 40_000 }))).toBe(false)
  expect(qualifies(prev, next({ resetsAt: '2026-11-13T10:00:00Z' }))).toBe(false)
  expect(qualifies(prev, next({ percent: 9 }))).toBe(false)
  expect(qualifies(undefined, next({}))).toBe(false)
})

test('learn decays old sums by 0.99 and adds the new pair', () => {
  const one = learn({ dPct: 0, usd: 0, n: 0 }, 1, 2)
  expect(one).toEqual({ dPct: 1, usd: 2, n: 1 })
  const two = learn(one, 1, 2)
  expect(two.n).toBe(2)
  expect(near(two.dPct, 1.99)).toBe(true)
  expect(near(two.usd, 3.98)).toBe(true)
})

test('factor needs 8 pairs, 1 point and some spend', () => {
  expect(factor({ dPct: 4, usd: 8, n: 8 })).toBe(0.5)
  expect(factor({ dPct: 4, usd: 8, n: 7 })).toBeNull()
  expect(factor({ dPct: 0.9, usd: 8, n: 9 })).toBeNull()
  expect(factor({ dPct: 4, usd: 0, n: 9 })).toBeNull()
})

test('share is spend times factor, clamped to the account figure', () => {
  expect(share(10, 0.5, 3)).toBe(3)
  expect(share(10, 0.5, 50)).toBe(5)
  expect(share(10, null, 50)).toBeNull()
})

test('hourBars gives five hourly figures from the window start', () => {
  const s = addSpend(addSpend({}, BASE + 30 * MIN, 1), BASE + 90 * MIN, 1)
  expect(hourBars(s, BASE, BASE + 2 * HOUR)).toEqual([1, 1, 0, 0, 0])
})

test('dayBars returns one bar per local calendar date inside [from, now]', () => {
  const from = new Date(2026, 10, 12, 22, 0).getTime()
  const now = new Date(2026, 10, 13, 2, 0).getTime()
  const s = addSpend(
    addSpend(addSpend({}, new Date(2026, 10, 12, 21, 0).getTime(), 5), new Date(2026, 10, 12, 23, 0).getTime(), 1),
    new Date(2026, 10, 13, 1, 0).getTime(),
    2,
  )
  const bars = dayBars(s, from, now)
  expect(bars).toEqual([
    { start: new Date(2026, 10, 12).getTime(), usd: 1 },
    { start: new Date(2026, 10, 13).getTime(), usd: 2 },
  ])
})

test('mergeSpend adds two sets of buckets minute by minute', () => {
  expect(mergeSpend({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 5, c: 4 })
})
