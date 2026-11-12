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
● #6 1:03    💰 $0.5421 | $13.87    🧠 ━━━━━━░░░░ 69%    ⏳ 59:57    ⚡ 104/s    🕒 21:13:05   [📊]
```

- `●` / `○` the current turn, running or idle, and how long it has run
- `💰` this turn's cost | the session's total (as `/cost` totals it)
- `🧠` the context window's fill, against the compaction window as `/context` measures it
- `⏳` time left on the main thread's prompt cache (1 hour after the last response)
- `⚡` output tokens per second of the last response
- `🕒` the time
- `📊` opens the pane

**The pane** has four tabs:

- **Summary**: input, output, cache write, cache read, web search, subagents and "Other", in tokens, dollars and share
- **Models**: each model's input, output and cache, tokens and dollars
- **Agents**: the main thread against the subagents, and each subagent's cost by model
- **Turns**: a stacked bar chart of each turn's cost, split into main thread and subagents or by token type; hover a bar for its breakdown, or press a turn for its details

Prices are first-party list prices (cache writes at the 5-minute rate). "Other" is the `/cost` total minus what the mod itemizes: the WebSearch tool's own model call, 1-hour cache writes, fast mode, compaction, and spend from before the mod loaded.
