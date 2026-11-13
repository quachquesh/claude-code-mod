# Usage panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, per machine, the estimated share of the plan's 5-hour and weekly windows this machine used, by hour and by day.

**Architecture:** Pure logic (buckets, calibration, estimates) in `session-cost/hooks/usage.ts`; `register.tsx` records spend and rate-limit readings per response and persists them through `$.store`; a fifth pane tab and one band group draw them.

**Tech Stack:** Claude Code mod API (`claude-code`, `claude-code/testing`), TSX, `claude plugin test`, `claude plugin validate`.

**Spec:** `docs/superpowers/specs/2026-11-13-usage-panel-design.md`

## Global Constraints

- Machine share = local USD x `k` of that kind, never above the account's `percentUsed`; shown with `~`, USD beside it.
- `k` is learned only from pairs of consecutive responses at most 30 s apart, same window, reading not falling; old sums x 0.99 before each add; `k = dPct / usd`; null until `n >= 8` and `dPct >= 1`.
- A window is a kind plus `resetsAt` rounded to the minute; start is `resetsAt - 5h` or `resetsAt - 7d`.
- Spend buckets are per minute, sparse, pruned after 8 days. Store keys: `usage-<instance id>` (that instance's spend) and `calibration` (shared).
- Store writes at most every 10 s and on `turn.complete`. Day bars are local calendar days; hour bars run from the window's start.
- Band group `📈 5h 34% 7d 12%` shows account figures, fixed width, lowest `keep` of all groups.
- Version 0.4.0. No network, no config.

## Review Focus

- No `resetsAt` or empty `rateLimits` (no subscription): no bars, "No subscription usage reported yet", no crash.
- Reading falls between two responses (window rolled over): that pair is skipped and the new window starts clean.
- `$.store` throws or returns junk: the panel still draws from memory.
- Estimate larger than the account's `percentUsed`: clamped to it.
- Response of a model with no price (`costOf` null): spend 0, never `NaN`.
- Day bars across a daylight-saving change or at midnight: one bar per calendar date, none doubled or missing.

---

## File Structure

- Create `session-cost/hooks/usage.ts`: pure functions, no `$`.
- Create `session-cost/tests/usage.test.ts`: unit tests of those functions.
- Modify `session-cost/types/index.d.ts`: new types and the `usage` state value; `Tab` gains `'usage'`.
- Modify `session-cost/hooks/register.tsx`: recording, persistence, tab, band group.
- Modify `session-cost/tests/cost.test.tsx`: `rateLimits` made settable; recording, tab and band tests.
- Modify `session-cost/.claude-plugin/plugin.json`, `README.md`.

### Task 1: Pure logic

**Files:**
- Create: `session-cost/hooks/usage.ts`, `session-cost/tests/usage.test.ts`
- Modify: `session-cost/types/index.d.ts`

**Interfaces:**
- Produces, in `types/index.d.ts`:
  `RateKind = 'five_hour' | 'seven_day'`;
  `Reading = { percent: number; resetsAt: string; at: number }`;
  `Calibration = { dPct: number; usd: number; n: number }`;
  `UsageLedger = { instance: string; spend: Record<string, number>; others: Record<string, number>; readings: Partial<Record<RateKind, Reading>>; calibration: Record<RateKind, Calibration> }` (`spend`/`others` map a minute-epoch string to USD);
  `PluginState['session-cost'].usage: Shaped<UsageLedger>`.
- Produces, in `usage.ts`:
  `windowId(resetsAt: string): number` (minutes since epoch, rounded);
  `windowStart(kind: RateKind, resetsAt: string): number` (ms);
  `addSpend(spend: Record<string, number>, at: number, usd: number): Record<string, number>`;
  `pruneSpend(spend: Record<string, number>, now: number): Record<string, number>`;
  `spendBetween(spend: Record<string, number>, from: number, to: number): number`;
  `qualifies(prev: Reading | undefined, next: Reading): boolean`;
  `learn(c: Calibration, dPct: number, usd: number): Calibration`;
  `factor(c: Calibration): number | null`;
  `share(usd: number, k: number | null, accountPct: number): number | null`;
  `hourBars(spend, from: number, now: number): number[]` (always 5 USD figures);
  `dayBars(spend, from: number, now: number): Array<{ start: number; usd: number }>`.

- [ ] **Step 1: Write the failing tests** in `tests/usage.test.ts`: `addSpend` puts 0.5 then 0.25 at the same minute into one key of 0.75; `pruneSpend` drops a key 9 days old and keeps one 7 days old; `qualifies` is true for a reading 20 s later, same `resetsAt` to the minute, higher percent, and false for 40 s later, for a different window, for a lower percent, and for `prev` undefined; `learn` twice from `{0,0,0}` with (1, 2) gives `n: 2` and `dPct` 1.99, `usd` 3.98; `factor` is null at `n: 7` and at `dPct: 0.9`, and 0.5 for `{ dPct: 4, usd: 8, n: 8 }`; `share(10, 0.5, 3)` is 3 (clamped), `share(10, null, 50)` is null; `hourBars` splits 1 USD at minute 30 and 1 USD at minute 90 of a window into `[1, 1, 0, 0, 0]`; `dayBars` over a span crossing local midnight returns two entries whose `start` are local midnights, and spend of `NaN` input to `addSpend` is stored as 0.
- [ ] **Step 2: Run** `claude plugin test session-cost` and expect the new tests to FAIL on a missing module.
- [ ] **Step 3: Add the types** above to `types/index.d.ts`; implement `usage.ts` with the signatures above. Day bars step through local dates with `new Date(y, m, d + 1)` rather than adding 24 h.
- [ ] **Step 4: Run** `claude plugin test session-cost` and `claude plugin validate session-cost`; expect all pass. This also proves the module may import `./usage` from `register.tsx`; if validate refuses a relative import, stop and report.
- [ ] **Step 5: Commit** `git add session-cost docs && git commit -m "session-cost: usage ledger logic"`.

### Task 2: Recording and persistence

**Files:**
- Modify: `session-cost/hooks/register.tsx` (atom `usage`, `turn.step`, `session.start`, `turn.complete`), `session-cost/tests/cost.test.tsx`

**Interfaces:**
- Consumes: everything produced by Task 1.
- Produces: atom `usage = atom({ plugin: 'session-cost', key: 'usage' } as const, EMPTY_USAGE, { shape: 'usage-1' })`; `async function recordResponse($, usd: number): Promise<void>`; `async function loadUsage($): Promise<void>`; `async function saveUsage($, force?: boolean): Promise<void>`.

- [ ] **Step 1: Write the failing tests** in `cost.test.tsx`: make the mock's `rateLimits` come from a module variable `limits` (default `[]`). Test "records spend and calibrates": set `limits` to `five_hour` 10 / `seven_day` 2, then raise by 0.5 / 0.1 between steps 10 s apart, nine responses of the Haiku usage; after them the `usage` atom (read with `$.state.get`) has `calibration.five_hour.n` of 8, `factor` not null. Test "skips the pair when the reading falls". Test "unpriced model records 0": a step whose model is `claude-unknown-1` leaves `spend` totals finite. Test "persists": after `turn.complete`, `$.store.keys()` includes the instance's `usage-` key and `calibration`; a second `session.start` loads `others` from it. Test "store failure": `$.store.set` made to reject by an `on('store.set', ...)` hook leaves the next response recorded in memory.
- [ ] **Step 2: Run** the tests; expect FAIL.
- [ ] **Step 3: Implement.** `recordResponse` is called from `turn.step` after `costOf`, for main and subagents: add spend at `$.clock.now()`, call `$.session.usage()`, build a `Reading` per kind from `rateLimits`, apply `qualifies`/`learn` with the response's USD, replace `readings`. `loadUsage` (in `session.start`) generates the instance id once, reads every `usage-*` key other than its own into `others`, reads `calibration`, drops spend older than 8 days. `saveUsage` writes at most every 10 s unless forced, inside try/catch.
- [ ] **Step 4: Run** the tests and validate; expect pass.
- [ ] **Step 5: Commit** `git commit -am "session-cost: record spend and calibrate per response"`.

### Task 3: Usage tab

**Files:**
- Modify: `session-cost/hooks/register.tsx` (tabs array near line 1318, tab body), `session-cost/tests/cost.test.tsx`

**Interfaces:**
- Consumes: `usage` atom, `windowStart`, `spendBetween`, `factor`, `share`, `hourBars`, `dayBars`.
- Produces: tab id `'usage'`, label `Usage`, hotkey `5`; `const usageView` rendered when `current === 'usage'`.

- [ ] **Step 1: Write the failing tests:** with readings and calibration seeded (state set through `$.state.set` before mounting), pressing `tab-usage` shows `~` shares for both windows, their USD, a reset time, five hour bars and one bar per local day; with `limits` empty it shows `No subscription usage reported yet`; with `n` below 8 it shows `calibrating` and no `~`.
- [ ] **Step 2: Run;** expect FAIL.
- [ ] **Step 3: Implement** the tab: for each kind, a header line (account % with a rail via `railSvg` on desktop, `━` cells on terminal as the other tabs do), this machine's `~%` and `$` , time to reset, then bars scaled to the largest bar, labelled `+1h`.. for hours and `Mon 12` style for days (first/last marked partial). Footnote: estimate learned from this machine's spend.
- [ ] **Step 4: Run** tests and validate; expect pass.
- [ ] **Step 5: Commit** `git commit -am "session-cost: usage tab"`.

### Task 4: Band group, docs, release

**Files:**
- Modify: `session-cost/hooks/register.tsx` (chips), `session-cost/tests/cost.test.tsx`, `session-cost/.claude-plugin/plugin.json`, `README.md`

**Interfaces:**
- Consumes: `usage.readings`.
- Produces: chip with `keep: 60`, text `📈 5h ${pad3(five)}% 7d ${pad3(seven)}%` (each figure whole percent, `padStart(3)`, `--` when absent); the group is omitted when there is no reading at all.

- [ ] **Step 1: Write the failing tests:** with readings 34 and 12 the band contains `📈 5h  34% 7d  12%`; with none it contains no `📈`; across `bodyColumns` 120 to 24 the `📈` goes before `⚡` does; width of the text is equal for 5% and 100%.
- [ ] **Step 2: Run;** expect FAIL.
- [ ] **Step 3: Implement** the chip in the chips array.
- [ ] **Step 4: Run** `claude plugin test session-cost` and `claude plugin validate session-cost`; expect all pass. Set version `0.4.0`; add the Usage tab and the `📈` group to `README.md`.
- [ ] **Step 5: Commit** `git commit -am "session-cost 0.4.0: plan usage by machine"`.
