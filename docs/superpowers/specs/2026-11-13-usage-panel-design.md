# session-cost: plan usage panel (per machine)

Status: draft for approval. Size: a small project (one new pane tab, one band chip, a small local ledger).

## Intent

The owner runs Claude Code on several machines at once under one subscription and wants to know
which machine eats the most of the plan. Nothing is shared between machines: each machine shows,
for itself, how much of the plan it used

- in the current 5-hour window, and in each hour of it;
- in the current week, counted from the weekly reset (not Monday to Sunday), and on each day of it.

The owner then compares machines by looking at each one.

## Constraint that shapes everything

`$.session.usage().rateLimits` gives `five_hour` and `seven_day`, each with `percentUsed`
(0 to 100, one decimal) and `resetsAt`. Those are account-wide: every machine reads the same figure.
So "% used by this machine" cannot be read; it has to be estimated. Only on a subscription, and
only after the first response of the session has carried a reading.

## Approaches considered

- **A. Credit the machine with every rise of the account %.** Simplest, but wrong with several
  machines: an idle machine's next response is credited with what the others used meanwhile.
  Rejected.
- **B. Calibrate from local spend (chosen by the owner).** Record the USD each local response costs
  (the mod already prices them). Learn a factor "% of window per USD" from back-to-back responses,
  where other machines have had little time to interfere, and apply it to all local spend.
- **C. Local USD only, no %.** Exact but leaves the conversion to the reader. Its numbers are shown
  next to B's anyway.

## Design (approach B)

**What is recorded.** On every model response (main thread and subagents) in `turn.step`, add the
response's USD (`costOf`) to a per-minute bucket (`minuteEpoch -> usd`, sparse, pruned after 8 days).
After each response, read `$.session.usage().rateLimits` and keep the latest reading per kind
(`percentUsed`, `resetsAt`).

**Windows.** A window is identified by its kind and `resetsAt` rounded to the minute. Its start is
`resetsAt - 5h` or `resetsAt - 7d`. Local spend in a window is the sum of buckets in
`[start, now]`. Spend before the mod loaded, or before the first reading, is not counted.

**Calibration**, one factor `k` per kind, shared by every session on this machine in one store key
`calibration` as decayed sums `{ dPct, usd, n }`. A pair qualifies when two consecutive responses on
this machine are at most 30 s apart, both readings are in the same window, and the reading did not
fall. Then `dPct += reading2 - reading1`, `usd += cost of response 2`, `n += 1`, and the old sums
are multiplied by 0.99 first. `k = dPct / usd`. Until `n >= 8` and `dPct >= 1`, the panel shows USD
only and says it is calibrating.

**Estimate.** Machine % of a window, an hour or a day = its USD x `k` of that kind, never above the
account's `percentUsed`. Shown with a `~`, the USD beside it.

**Buckets shown.**
- 5h window: five bars, each one hour from the window's start (not clock hours).
- Week: one bar per local calendar day from the reset to now. The first and last days are partial
  because the week starts mid-day (owner's call to confirm: calendar days, not 24-hour blocks from
  the reset).

**Persistence.** `$.store`, per machine, survives sessions. Spend is written under one key per
session instance (`usage-<random id>`, holding only that instance's buckets) so concurrent sessions
never overwrite each other; the panel sums all `usage-*` keys. Writes are batched, at most once every
10 s and on `turn.complete`. Calibration is the one shared key, read-modify-write, where a lost
update only costs a sample.

**Pane.** A fifth tab, `Usage` (`Tab` gains `'usage'`). For each of 5h and week: account % as a bar,
this machine's `~%` and USD, time to reset, then the bars above. A one-line footnote says the machine
share is an estimate learned from this machine's own spend. With no readings: "No subscription usage
reported yet".

**Band.** One more group, lowest priority (dropped first), `📈 5h 34% 7d 12%`: the account's figures,
what the limit is measured on. Fixed width (`mm` figures padded), like the timers.

## Goals / non-goals

Goals: per-machine view of 5h, per-hour, week, per-day; survives restarts; no network, no setup.
Non-goals: syncing between machines; exact attribution; alerts or toasts at a threshold; the
gateway's `spend_limit`; anything for non-subscription accounts.
Anti-goal: a figure that looks exact when it is an estimate (hence `~`, the USD beside it, and the
calibrating state).

## Left to the builder (to verify, not assumed)

- That a response's reading updates `rateLimits` every time, not only when a whole point moves.
- How `resetsAt` jitters between readings of one window (the one-minute rounding is a guess).
- Whether `$.store` writes from two processes can drop each other's keys; if so, move spend to a
  per-instance key scheme already assumed above, and keep calibration tolerant of loss.
- How the tests mock `rateLimits` in `session.usage`.
- Bump the version to 0.4.0 and add the tab and chip to the README.
