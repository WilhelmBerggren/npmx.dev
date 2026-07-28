# npmx-tui

> Browse the npm registry from your terminal — a TUI prototype for [npmx.dev](https://npmx.dev), built on [OpenTUI](https://opentui.dev).

Browse-only MVP: **search** the registry and open a **package detail** view with
README (rendered markdown), versions, dependencies, and health signals
(downloads, install size, vulnerabilities).

## Requirements

OpenTUI's native renderer needs one of:

- **Node.js ≥ 26.4** with `--experimental-ffi` (what the scripts use), or
- **Bun**

The `--demo` mode below has no such requirement — it never loads OpenTUI and
runs on any Node.

## Run

TypeScript runs directly (Node type-stripping), so there is no build step:

```bash
# interactive TUI (needs Node 26.4+)
pnpm --filter npmx-tui dev
pnpm --filter npmx-tui dev vue          # preload a search query
# or directly:
node --experimental-ffi src/index.ts [query]

# headless smoke test (no TTY / no OpenTUI) — prints a scripted search + summary
pnpm --filter npmx-tui demo react
node src/index.ts --demo react
```

Point it at a local npmx during development:

```bash
NPMX_API=http://127.0.0.1:3000 node --experimental-ffi src/index.ts
```

The palette follows your terminal's light/dark theme automatically. Force one
if detection is wrong:

```bash
NPMX_THEME=light node --experimental-ffi src/index.ts
```

## Keys

**Search:** type to search · `↑`/`↓` move · `PgUp`/`PgDn` page · `⏎` open · `Esc` clear/quit · `^C` quit

**Detail:** `←`/`→` switch section · `1`–`4` jump · `↑`/`↓`/`PgUp`/`PgDn` scroll · `Esc` back · `q` quit

## How it works

- **Data** (`src/api.ts`): core reads (search, packument, versions, deps,
  README) come straight from the npm registry — the same sources the web app
  uses. Enriched signals (install size, vulnerabilities, README fallback) come
  from the `npmx.dev/api/*` endpoints, reusing npmx's server-side computation
  instead of reimplementing it.
- **UI** (`src/ui.ts`): OpenTUI core (factory/renderable API). Two views toggle
  via `.visible`; a focused `Input` drives a debounced search into a `Select`,
  and in detail a focused `TabSelect` switches sections while a `ScrollBox`
  scrolls the body. READMEs render through OpenTUI's `MarkdownRenderable`.
- **Entry** (`src/index.ts`): lazily imports the UI so `--demo`/headless runs
  never touch the native renderer.

## Next steps

- Code viewer / diff / changelog / comparison / org & user pages.
- Wire the `npmx-connector` (`../cli`) for authenticated admin operations.
- Reuse `#shared/utils/*` (package analysis, spdx, severity) directly.
