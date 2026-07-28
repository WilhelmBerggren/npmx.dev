/**
 * Headless smoke test of the data layer — no OpenTUI, so it runs under any
 * Node (including the repo's Node 24). Prints a scripted search + package
 * summary. Used for verification in CI or a non-TTY shell.
 */
import process from 'node:process'
import { getHealth, getPackage, search } from './api.ts'

export async function runDemo(query: string): Promise<void> {
  const q = query || 'nuxt'
  process.stdout.write(`\n  npmx-tui demo — searching "${q}"\n\n`)
  const { total, results } = await search(q, 8)
  process.stdout.write(`  ${total.toLocaleString()} results (showing ${results.length}):\n`)
  for (const r of results) {
    process.stdout.write(`   • ${r.name}@${r.version} — ${(r.description || '').slice(0, 60)}\n`)
  }

  const first = results[0]
  if (!first) return
  process.stdout.write(`\n  Package detail for ${first.name}:\n`)
  const pkg = await getPackage(first.name)
  process.stdout.write(`   latest:   ${pkg.latest}\n`)
  process.stdout.write(`   license:  ${pkg.license ?? '—'}\n`)
  process.stdout.write(`   repo:     ${pkg.repository ?? '—'}\n`)
  process.stdout.write(`   versions: ${pkg.versions.length}\n`)
  process.stdout.write(
    `   deps:     ${pkg.dependencies.length} runtime, ${pkg.devDependencyCount} dev\n`,
  )
  process.stdout.write(`   readme:   ${pkg.readme.length} chars\n`)

  process.stdout.write(`\n  Health (npmx.dev API):\n`)
  const h = await getHealth(first.name)
  process.stdout.write(`   weekly downloads: ${h.weeklyDownloads?.toLocaleString() ?? '—'}\n`)
  process.stdout.write(
    `   install size:     ${h.installSize ? `${h.installSize.totalSize} bytes, ${h.installSize.dependencyCount} deps` : '—'}\n`,
  )
  process.stdout.write(
    `   vulnerabilities:  ${h.vulnerabilities ? h.vulnerabilities.total : '—'}\n\n`,
  )
}
