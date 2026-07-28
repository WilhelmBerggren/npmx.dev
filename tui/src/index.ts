#!/usr/bin/env node
/**
 * npmx-tui entry point.
 *
 * Interactive (a TTY): launches the OpenTUI browser. Requires Node 26.4+ with
 * `--experimental-ffi` (see package.json scripts) or Bun.
 *   node --experimental-ffi src/index.ts [query]
 *
 * Non-interactive / --demo: prints a scripted search + package summary. Runs
 * under any Node and never loads OpenTUI.
 *   node src/index.ts --demo [query]
 */
import process from 'node:process'
import { runDemo } from './demo.ts'

function parseArgs(argv: string[]): { demo: boolean; query: string } {
  const args = argv.slice(2)
  const demo = args.includes('--demo')
  const query = args.filter(a => !a.startsWith('-')).join(' ')
  return { demo, query }
}

const { demo, query } = parseArgs(process.argv)

if (demo || !process.stdin.isTTY) {
  runDemo(query).catch(err => {
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    process.exit(1)
  })
} else {
  // Load the OpenTUI app lazily so demo/headless runs never touch the native renderer.
  const { runApp } = await import('./ui.ts')
  runApp(query).then(
    () => process.exit(0),
    err => {
      process.stderr.write(`Error: ${(err as Error).message}\n`)
      process.exit(1)
    },
  )
}
