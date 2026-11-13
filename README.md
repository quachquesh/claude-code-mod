# claude-code-mod

A marketplace of mods for [Claude Code](https://code.claude.com).

## Mods

| Mod | What it does |
| --- | --- |
| [`session-cost`](./session-cost) | Live cost of the session: a one-row band above the prompt and a pane with the breakdown |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-cost --marketplace quachquesh/claude-code-mod
```

Answer `y` to add the marketplace, then pick a scope (Enter takes the user scope, every session).

From a shell:

```bash
claude plugin install session-cost --marketplace quachquesh/claude-code-mod
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `quachquesh/claude-code-mod`, then **Add plugin**.

## session-cost

**The band above the prompt**, one row:

```
● #6 01:03 💰 $0.5421 | $13.87 🧠 ━━━━━━░░░░ 69% ⏳ 59:57 ⚡ 104/s 📈 5h  34% 7d  12% 🕒 21:13:05   [📊]
```

- `●` / `○` the current turn, running or idle, and how long it has run
- `💰` this turn's cost | the session's total (as `/cost` totals it)
- `🧠` the context window's fill, against the compaction window as `/context` measures it
- `⏳` time left on the main thread's prompt cache (1 hour after the last response), `mm:ss`; `⌛ 00:00` once it has lapsed
- `⚡` output tokens per second of the last response
- `📈` how much of the plan's 5-hour and weekly windows the account has used (subscription only; the first group to go when the row is short)
- `🕒` the time
- `📊` opens the pane

**The pane** opens on the session's cost, tokens and time, over five tabs:

- **Summary**: input, output, cache write, cache read, web search, subagents and "Other", in tokens, dollars and share
- **Models**: each model's input, output and cache, tokens and dollars
- **Agents**: the main thread against the subagents, then a card for each subagent, grouped into Running and Finished: its task, type, model and effort, its context fill, tokens, cost and run time, and a bar of its cost against the priciest one. Press a card for the subagent's page: each request as a bar split by token type, with the running total over them (hover a bar for its figures), its cost by token type, the tools it called, its task and its answer. With a subagent's transcript in view, the tab opens on that subagent's page
- **Turns**: a stacked bar chart of each turn's cost, split into main thread and subagents or by token type; hover a bar for its breakdown, or press a turn for its details
- **Usage**: how much of the plan's 5-hour window and of the week (counted from its reset) this machine used, and by hour of the window and by day (a `·` marks a partial day). The account's percent is the same on every machine, so this machine's share is an estimate: its own spend at list price times the account points per dollar it learned from its back-to-back responses (shown with `~`, and "calibrating" until it has seen enough). Kept in the plugin's store, so it survives restarts; nothing is shared between machines

Prices are first-party list prices (cache writes at the 5-minute rate). "Other" is the `/cost` total minus what the mod itemizes: the WebSearch tool's own model call, 1-hour cache writes, fast mode, compaction, and spend from before the mod loaded.
