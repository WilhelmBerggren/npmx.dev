/**
 * Data layer for the npmx TUI.
 *
 * Core reads (search, packument, downloads) hit the npm registry directly, which
 * is exactly what the npmx web app does. The enriched, computed signals
 * (install size, vulnerabilities) come from the npmx.dev public API, so the TUI
 * gets npmx's server-side work "for free" without reimplementing it.
 *
 * Override the npmx base with NPMX_API (e.g. http://127.0.0.1:3000 for local dev).
 */
import process from 'node:process'

const NPM_REGISTRY = 'https://registry.npmjs.org'
const NPM_DOWNLOADS = 'https://api.npmjs.org'
const NPMX_API = process.env.NPMX_API ?? 'https://npmx.dev'

const DEFAULT_TIMEOUT = 10_000

/**
 * npm registry endpoints need the scope slash encoded: @scope/name -> @scope%2Fname
 */
export function encodePackageName(name: string): string {
  if (name.startsWith('@')) return `@${encodeURIComponent(name.slice(1))}`
  return encodeURIComponent(name)
}

/**
 * npmx.dev API routes are catch-all (`[...pkg]`) segments and expect the literal
 * slash of a scoped name (a `%2F`-encoded slash 404s), so pass the name as-is.
 */
function npmxPath(name: string): string {
  return name
}

async function getJSON<T>(url: string, timeout = DEFAULT_TIMEOUT): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export interface SearchResult {
  name: string
  version: string
  description: string
  date?: string
  publisher?: string
  weeklyDownloads?: number
}

interface RawSearchResponse {
  total: number
  objects: Array<{
    downloads?: { weekly?: number }
    package: {
      name: string
      version: string
      description?: string
      date?: string
      publisher?: { username?: string }
    }
  }>
}

export async function search(
  query: string,
  size = 25,
): Promise<{ total: number; results: SearchResult[] }> {
  const params = new URLSearchParams({ text: query, size: String(size) })
  const data = await getJSON<RawSearchResponse>(`${NPM_REGISTRY}/-/v1/search?${params}`)
  return {
    total: data.total,
    results: data.objects.map(o => ({
      name: o.package.name,
      version: o.package.version,
      description: o.package.description ?? '',
      date: o.package.date,
      publisher: o.package.publisher?.username,
      weeklyDownloads: o.downloads?.weekly,
    })),
  }
}

export interface PackageVersion {
  version: string
  date?: string
  deprecated?: string | false
}

export interface Dependency {
  name: string
  range: string
}

export interface PackageDetail {
  name: string
  description: string
  latest: string
  license?: string
  homepage?: string
  repository?: string
  author?: string
  keywords: string[]
  deprecated?: string | false
  readme: string
  created?: string
  modified?: string
  versions: PackageVersion[]
  dependencies: Dependency[]
  devDependencyCount: number
}

interface Packument {
  'name': string
  'description'?: string
  'readme'?: string
  'license'?: string | { type?: string }
  'homepage'?: string
  'author'?: string | { name?: string }
  'keywords'?: string[]
  'repository'?: string | { url?: string }
  'dist-tags'?: Record<string, string>
  'time'?: Record<string, string>
  'versions': Record<
    string,
    {
      version: string
      deprecated?: string | false
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      license?: string | { type?: string }
    }
  >
}

function normalizeLicense(license?: string | { type?: string }): string | undefined {
  if (!license) return undefined
  return typeof license === 'string' ? license : license.type
}

function normalizeRepo(repo?: string | { url?: string }): string | undefined {
  const raw = typeof repo === 'string' ? repo : repo?.url
  if (!raw) return undefined
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
}

/**
 * npmx resolves READMEs even when the registry packument omits the top-level
 * `readme` field (common for scoped/monorepo packages). Best-effort.
 */
async function fetchNpmxReadme(name: string): Promise<string | undefined> {
  try {
    const data = await getJSON<{ markdown?: string }>(
      `${NPMX_API}/api/registry/readme/markdown/${npmxPath(name)}`,
    )
    return data.markdown || undefined
  } catch {
    return undefined
  }
}

export async function getPackage(name: string): Promise<PackageDetail> {
  const pkg = await getJSON<Packument>(`${NPM_REGISTRY}/${encodePackageName(name)}`, 15_000)
  const latest = pkg['dist-tags']?.latest ?? Object.keys(pkg.versions).at(-1) ?? ''
  const latestMeta = pkg.versions[latest]

  const versions: PackageVersion[] = Object.keys(pkg.versions)
    .filter(v => pkg.time?.[v])
    .sort((a, b) => Date.parse(pkg.time![b]!) - Date.parse(pkg.time![a]!))
    .map(v => ({
      version: v,
      date: pkg.time?.[v],
      deprecated: pkg.versions[v]?.deprecated,
    }))

  const dependencies: Dependency[] = Object.entries(latestMeta?.dependencies ?? {})
    .map(([n, range]) => ({ name: n, range }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const readme = pkg.readme?.trim() ? pkg.readme : ((await fetchNpmxReadme(pkg.name)) ?? '')

  return {
    name: pkg.name,
    description: pkg.description ?? '',
    latest,
    license: normalizeLicense(latestMeta?.license ?? pkg.license),
    homepage: pkg.homepage,
    repository: normalizeRepo(pkg.repository),
    author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name,
    keywords: pkg.keywords ?? [],
    deprecated: latestMeta?.deprecated,
    readme,
    created: pkg.time?.created,
    modified: pkg.time?.modified,
    versions,
    dependencies,
    devDependencyCount: Object.keys(latestMeta?.devDependencies ?? {}).length,
  }
}

export interface Health {
  weeklyDownloads?: number
  installSize?: { totalSize: number; dependencyCount: number }
  vulnerabilities?: { total: number; critical: number; high: number; moderate: number; low: number }
}

export async function getWeeklyDownloads(name: string): Promise<number | undefined> {
  try {
    const data = await getJSON<{ downloads: number }>(
      `${NPM_DOWNLOADS}/downloads/point/last-week/${encodePackageName(name)}`,
    )
    return data.downloads
  } catch {
    return undefined
  }
}

/** Enriched, npmx-computed signals. Best-effort: any failure resolves to undefined. */
export async function getHealth(name: string): Promise<Health> {
  const [downloads, size, vulns] = await Promise.all([
    getWeeklyDownloads(name),
    getJSON<{ totalSize: number; dependencyCount: number }>(
      `${NPMX_API}/api/registry/install-size/${npmxPath(name)}`,
      20_000,
    ).catch(() => undefined),
    getJSON<{ totalCounts: Health['vulnerabilities'] }>(
      `${NPMX_API}/api/registry/vulnerabilities/${npmxPath(name)}`,
      15_000,
    ).catch(() => undefined),
  ])

  return {
    weeklyDownloads: downloads,
    installSize: size
      ? { totalSize: size.totalSize, dependencyCount: size.dependencyCount }
      : undefined,
    vulnerabilities: vulns?.totalCounts,
  }
}
