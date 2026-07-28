/**
 * The interactive TUI, built on OpenTUI's core (factory/renderable) API.
 *
 * Two views live under the root at once and toggle via `.visible`:
 *   - search: a focused Input drives a debounced registry search into a Select
 *   - detail: a focused TabSelect switches sections; a ScrollBox shows the body
 *
 * Data comes from ./api.ts (npm registry + npmx.dev API). Rendering, layout
 * (flexbox via Yoga), scrolling, and input are all handled by OpenTUI.
 *
 * The palette adapts to the terminal's light/dark theme (detected by OpenTUI),
 * and the detail header is a fixed height so it never reflows between tabs.
 */
import process from 'node:process'
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  SelectRenderable,
  TabSelectRenderable,
  ScrollBoxRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  RGBA,
  InputRenderableEvents,
  TabSelectRenderableEvents,
  t,
  bold,
  fg,
  type CliRenderer,
  type KeyEvent,
  type StyledText,
  type ThemeMode,
} from '@opentui/core'
import {
  search,
  getPackage,
  getHealth,
  type Health,
  type PackageDetail,
  type SearchResult,
} from './api.ts'

interface Palette {
  accent: string
  fg: string
  dim: string
  faint: string
  green: string
  yellow: string
  red: string
  blue: string
  bar: string
  selBg: string
}

// npm red works on both; the rest follow GitHub's light/dark UI palettes.
const DARK: Palette = {
  accent: '#cb3837',
  fg: '#e6edf3',
  dim: '#8b949e',
  faint: '#6e7681',
  green: '#3fb950',
  yellow: '#d29922',
  red: '#f85149',
  blue: '#58a6ff',
  bar: '#161b22',
  selBg: '#21262d',
}
const LIGHT: Palette = {
  accent: '#cb3837',
  fg: '#1f2328',
  dim: '#57606a',
  faint: '#8c959f',
  green: '#1a7f37',
  yellow: '#9a6700',
  red: '#cf222e',
  blue: '#0969da',
  bar: '#eaeef2',
  selBg: '#d0d7de',
}

const TABS = ['Readme', 'Versions', 'Dependencies', 'Health'] as const

function relativeDate(iso?: string): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatCount(n?: number): string {
  if (n == null) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function truncate(s: string, width: number): string {
  if (width <= 0 || s.length <= width) return s
  return `${s.slice(0, Math.max(0, width - 1))}…`
}

/**
 * OpenTUI's markdown renderer passes raw inline HTML through verbatim, so the
 * badge/logo blocks common at the top of READMEs (anchors wrapping images) show
 * up as literal `<a href…><img…></a>` noise. Convert the common HTML link/image
 * shapes to markdown links so they render as underlined link text via the
 * `markup.link` syntax style.
 */
function normalizeReadmeHtml(md: string): string {
  const attr = (tag: string, name: string): string | undefined =>
    tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1]

  return (
    md
      // Theme-aware image wrappers: keep the inner content, drop the wrappers.
      .replace(/<\/?(?:picture|source)\b[^>]*>/gi, '')
      // Anchor wrapping an image → [alt-or-image](href)
      .replace(/<a\b[^>]*>\s*(<img\b[^>]*>)\s*<\/a>/gi, (m, img: string) => {
        const href = attr(m, 'href') ?? ''
        const alt = attr(img, 'alt') ?? 'image'
        return href ? `[${alt}](${href})` : alt
      })
      // Anchor wrapping text → [text](href)
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (m, inner: string) => {
        const href = attr(m, 'href') ?? ''
        const text = inner.replace(/<[^>]+>/g, '').trim()
        return href ? `[${text || href}](${href})` : text
      })
      // Standalone image → its alt text (dropped if it has none)
      .replace(/<img\b[^>]*>/gi, img => attr(img, 'alt') ?? '')
      // Line breaks and leftover structural wrappers.
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(?:p|div|span)\b[^>]*>/gi, '')
  )
}

class NpmxTui {
  private renderer: CliRenderer
  private c: Palette

  private mode: 'search' | 'detail' = 'search'

  // search view
  private searchView!: BoxRenderable
  private brandText!: TextRenderable
  private input!: InputRenderable
  private results!: SelectRenderable
  private searchStatus!: TextRenderable
  private searchFooterText!: TextRenderable
  private resultData: SearchResult[] = []
  private searchTimer: ReturnType<typeof setTimeout> | null = null
  private reqId = 0

  // detail view
  private detailView!: BoxRenderable
  private detailTitle!: TextRenderable
  private detailDesc!: TextRenderable
  private detailMeta!: TextRenderable
  private tabs!: TabSelectRenderable
  private scroll!: ScrollBoxRenderable
  private body!: BoxRenderable
  private scrollHint!: TextRenderable
  private detailFooterText!: TextRenderable
  private pkg: PackageDetail | null = null
  private detailName = ''
  private tabIndex = 0
  private health: Health | null = null
  private healthLoading = false

  // chrome that needs recoloring on a live theme change
  private bars: BoxRenderable[] = []
  private syntaxStyle!: SyntaxStyle

  constructor(renderer: CliRenderer, theme: 'dark' | 'light') {
    this.renderer = renderer
    this.c = theme === 'light' ? LIGHT : DARK
  }

  build(): void {
    this.syntaxStyle = this.makeSyntaxStyle()
    this.buildSearchView()
    this.buildDetailView()
    this.renderer.root.add(this.searchView)
    this.renderer.root.add(this.detailView)
    this.setMode('search')

    this.renderer.keyInput.on('keypress', k => this.onKey(k))
    this.renderer.on('resize', () => {
      if (this.mode === 'detail' && this.pkg) {
        this.renderHeader()
        this.renderTab()
      }
    })
  }

  preloadQuery(query: string): void {
    this.input.value = query
    this.scheduleSearch(query)
  }

  private makeSyntaxStyle(): SyntaxStyle {
    return SyntaxStyle.fromStyles({
      'default': { fg: RGBA.fromHex(this.c.fg) },
      'markup.heading': { fg: RGBA.fromHex(this.c.blue), bold: true },
      'markup.heading.1': { fg: RGBA.fromHex(this.c.accent), bold: true },
      'markup.heading.2': { fg: RGBA.fromHex(this.c.blue), bold: true },
      'markup.list': { fg: RGBA.fromHex(this.c.accent) },
      'markup.raw': { fg: RGBA.fromHex(this.c.green) },
      'markup.raw.block': { fg: RGBA.fromHex(this.c.green) },
      'markup.strong': { fg: RGBA.fromHex(this.c.fg), bold: true },
      'markup.italic': { fg: RGBA.fromHex(this.c.fg), italic: true },
      'markup.strikethrough': { fg: RGBA.fromHex(this.c.dim) },
      'markup.quote': { fg: RGBA.fromHex(this.c.dim), italic: true },
      // Link text renders underlined; the URL itself is dimmed (usually concealed).
      'markup.link': { fg: RGBA.fromHex(this.c.blue), underline: true },
      'markup.link.label': { fg: RGBA.fromHex(this.c.blue), underline: true },
      'markup.link.url': { fg: RGBA.fromHex(this.c.faint), underline: true },
    })
  }

  // ---------- search view ----------

  private buildSearchView(): void {
    const r = this.renderer
    this.searchView = new BoxRenderable(r, {
      id: 'search-view',
      width: '100%',
      height: '100%',
      flexDirection: 'column',
    })

    const header = new BoxRenderable(r, {
      id: 'search-header',
      width: '100%',
      height: 1,
      flexShrink: 0,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: this.c.bar,
    })
    this.brandText = new TextRenderable(r, { content: this.brandContent() })
    this.searchStatus = new TextRenderable(r, { content: '', fg: this.c.dim })
    header.add(this.brandText)
    header.add(this.searchStatus)
    this.bars.push(header)

    const inputRow = new BoxRenderable(r, {
      id: 'search-input-row',
      width: '100%',
      height: 1,
      flexShrink: 0,
      flexDirection: 'row',
      paddingLeft: 1,
      paddingRight: 1,
    })
    inputRow.add(new TextRenderable(r, { content: t`${fg(this.c.accent)('❯ ')}` }))
    this.input = new InputRenderable(r, {
      id: 'search-input',
      flexGrow: 1,
      placeholder: 'Search the npm registry…',
      textColor: this.c.fg,
      cursorColor: this.c.accent,
    })
    inputRow.add(this.input)

    this.results = new SelectRenderable(r, {
      id: 'search-results',
      flexGrow: 1,
      width: '100%',
      options: [],
      showDescription: true,
      showScrollIndicator: true,
      wrapSelection: false,
      textColor: this.c.fg,
      selectedBackgroundColor: this.c.selBg,
      selectedTextColor: this.c.accent,
      descriptionColor: this.c.faint,
      selectedDescriptionColor: this.c.dim,
    })

    const footer = new BoxRenderable(r, {
      id: 'search-footer',
      width: '100%',
      height: 1,
      flexShrink: 0,
      paddingLeft: 1,
      backgroundColor: this.c.bar,
    })
    this.searchFooterText = new TextRenderable(r, { content: this.searchFooterContent() })
    footer.add(this.searchFooterText)
    this.bars.push(footer)

    this.searchView.add(header)
    this.searchView.add(inputRow)
    this.searchView.add(this.results)
    this.searchView.add(footer)

    this.input.on(InputRenderableEvents.INPUT, (value: string) => {
      this.scheduleSearch(value)
    })
  }

  private brandContent() {
    return t`${bold(fg(this.c.accent)('npmx'))} ${fg(this.c.dim)('· registry browser')}`
  }

  private searchFooterContent() {
    return t`${fg(this.c.dim)('↑↓ move   ⏎ open   esc clear/quit   ^C quit')}`
  }

  private scheduleSearch(query: string): void {
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => void this.doSearch(query), 250)
  }

  private async doSearch(query: string): Promise<void> {
    const q = query.trim()
    if (!q) {
      this.resultData = []
      this.results.options = []
      this.searchStatus.content = ''
      return
    }
    const id = ++this.reqId
    this.searchStatus.content = 'searching…'
    try {
      const { total, results } = await search(q)
      if (id !== this.reqId) return
      this.resultData = results
      this.results.options = results.map(res => ({
        name: res.name,
        description: `${res.version}  ${res.weeklyDownloads != null ? `↓${formatCount(res.weeklyDownloads)}  ` : ''}${res.description}`,
        value: res.name,
      }))
      this.searchStatus.content = results.length
        ? `${total.toLocaleString()} results`
        : 'no results'
    } catch (err) {
      if (id !== this.reqId) return
      this.resultData = []
      this.results.options = []
      this.searchStatus.content = `error: ${(err as Error).message}`
    }
  }

  // ---------- detail view ----------

  private buildDetailView(): void {
    const r = this.renderer
    this.detailView = new BoxRenderable(r, {
      id: 'detail-view',
      width: '100%',
      height: '100%',
      flexDirection: 'column',
    })

    // Top bar (1 row): title line. Fixed height so it never reflows.
    const titleBar = new BoxRenderable(r, {
      id: 'detail-title-bar',
      width: '100%',
      height: 1,
      flexShrink: 0,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: this.c.bar,
    })
    this.detailTitle = new TextRenderable(r, { content: '' })
    titleBar.add(this.detailTitle)
    this.bars.push(titleBar)

    // Sub-header (2 rows): description + meta. Fixed height, single-line each.
    const sub = new BoxRenderable(r, {
      id: 'detail-sub',
      width: '100%',
      height: 2,
      flexShrink: 0,
      flexDirection: 'column',
      paddingLeft: 1,
      paddingRight: 1,
    })
    this.detailDesc = new TextRenderable(r, { content: '', height: 1, fg: this.c.dim })
    this.detailMeta = new TextRenderable(r, { content: '', height: 1, fg: this.c.faint })
    sub.add(this.detailDesc)
    sub.add(this.detailMeta)

    this.tabs = new TabSelectRenderable(r, {
      id: 'detail-tabs',
      width: '100%',
      height: 1,
      flexShrink: 0,
      tabWidth: 16,
      showDescription: false,
      showUnderline: true,
      options: TABS.map(name => ({ name, description: '' })),
      textColor: this.c.dim,
      backgroundColor: 'transparent',
      focusedBackgroundColor: 'transparent',
      selectedBackgroundColor: this.c.selBg,
      selectedTextColor: this.c.accent,
    })

    this.scroll = new ScrollBoxRenderable(r, {
      id: 'detail-scroll',
      flexGrow: 1,
      width: '100%',
      scrollY: true,
    })
    this.body = new BoxRenderable(r, {
      id: 'detail-body',
      width: '100%',
      flexDirection: 'column',
      paddingLeft: 1,
      paddingRight: 1,
    })
    this.scroll.add(this.body)

    const footer = new BoxRenderable(r, {
      id: 'detail-footer',
      width: '100%',
      height: 1,
      flexShrink: 0,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: this.c.bar,
    })
    this.detailFooterText = new TextRenderable(r, { content: this.detailFooterContent() })
    this.scrollHint = new TextRenderable(r, { content: '', fg: this.c.faint })
    footer.add(this.detailFooterText)
    footer.add(this.scrollHint)
    this.bars.push(footer)

    this.detailView.add(titleBar)
    this.detailView.add(sub)
    this.detailView.add(this.tabs)
    this.detailView.add(this.scroll)
    this.detailView.add(footer)

    this.tabs.on(TabSelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
      if (index === this.tabIndex) return
      this.tabIndex = index
      this.renderTab()
    })
  }

  private detailFooterContent() {
    return t`${fg(this.c.dim)('←→ tabs   ↑↓/pgup/pgdn scroll   esc back   q quit')}`
  }

  private async openDetail(name: string): Promise<void> {
    this.detailName = name
    this.pkg = null
    this.health = null
    this.healthLoading = false
    this.tabIndex = 0
    this.setTabIndex(0)
    this.setMode('detail')

    this.detailTitle.content = t`${bold(fg(this.c.accent)(name))}`
    this.detailDesc.content = 'loading…'
    this.detailMeta.content = ''
    this.clearBody()

    try {
      const pkg = await getPackage(name)
      if (this.detailName !== name) return
      this.pkg = pkg
      this.renderHeader()
      this.tabs.options = [
        { name: 'Readme', description: '' },
        { name: `Versions (${pkg.versions.length})`, description: '' },
        { name: `Dependencies (${pkg.dependencies.length})`, description: '' },
        { name: 'Health', description: '' },
      ]
      this.renderTab()
    } catch (err) {
      if (this.detailName !== name) return
      this.detailDesc.content = t`${fg(this.c.red)(`failed to load: ${(err as Error).message}`)}`
    }
  }

  private renderHeader(): void {
    const p = this.pkg!
    const w = Math.max(10, this.renderer.width - 2)
    const name = truncate(p.name, w - 20)
    this.detailTitle.content = t`${bold(fg(this.c.accent)(name))} ${fg(this.c.dim)(`@${p.latest}`)}${p.license ? '  ' : ''}${p.license ? fg(this.c.dim)(p.license) : ''}${p.deprecated ? '  ' : ''}${p.deprecated ? fg(this.c.red)('DEPRECATED') : ''}`
    this.detailDesc.content = truncate(p.description || '', w)
    const meta = [
      p.author ? `by ${p.author}` : '',
      p.modified ? `updated ${relativeDate(p.modified)}` : '',
      (p.repository ?? p.homepage)?.replace(/^https?:\/\//, ''),
    ]
      .filter(Boolean)
      .join('  ·  ')
    this.detailMeta.content = truncate(meta, w)
  }

  private renderTab(): void {
    this.clearBody()
    this.scroll.scrollTo({ x: 0, y: 0 })
    const p = this.pkg
    if (!p) return
    const r = this.renderer

    switch (TABS[this.tabIndex]) {
      case 'Readme': {
        const md = new MarkdownRenderable(r, {
          id: 'readme-md',
          width: Math.max(20, this.renderer.width - 4),
          content: p.readme ? normalizeReadmeHtml(p.readme) : '_No README available._',
          syntaxStyle: this.syntaxStyle,
          conceal: true,
        })
        this.body.add(md)
        break
      }
      case 'Versions': {
        for (const v of p.versions.slice(0, 200)) {
          const tag = p.latest === v.version ? fg(this.c.green)(' latest') : ''
          const dep = v.deprecated ? fg(this.c.red)(' deprecated') : ''
          this.body.add(
            this.line(t`${bold(v.version)}${tag}${dep}  ${fg(this.c.faint)(relativeDate(v.date))}`),
          )
        }
        break
      }
      case 'Dependencies': {
        if (!p.dependencies.length) {
          this.body.add(this.line(t`${fg(this.c.dim)('No runtime dependencies.')}`))
        } else {
          this.body.add(
            this.line(
              t`${fg(this.c.dim)(`${p.dependencies.length} runtime · ${p.devDependencyCount} dev`)}`,
            ),
          )
          for (const d of p.dependencies) {
            this.body.add(this.line(t`${fg(this.c.blue)(d.name)} ${fg(this.c.faint)(d.range)}`))
          }
        }
        break
      }
      case 'Health': {
        this.renderHealth()
        break
      }
    }
  }

  private renderHealth(): void {
    if (!this.health) {
      this.body.add(this.line(t`${fg(this.c.dim)('Loading health signals…')}`))
      if (!this.healthLoading && this.pkg) {
        this.healthLoading = true
        const name = this.pkg.name
        void getHealth(name).then(h => {
          if (this.detailName !== name) return
          this.health = h
          this.healthLoading = false
          if (TABS[this.tabIndex] === 'Health') this.renderTab()
        })
      }
      return
    }

    const h = this.health
    this.body.add(this.line(t`${bold('Weekly downloads')}   ${formatCount(h.weeklyDownloads)}`))
    this.body.add(this.line(''))
    this.body.add(
      this.line(
        h.installSize
          ? t`${bold('Install size')}      ${formatBytes(h.installSize.totalSize)} ${fg(this.c.faint)(`(${h.installSize.dependencyCount} deps)`)}`
          : t`${bold('Install size')}      ${fg(this.c.faint)('unavailable')}`,
      ),
    )
    this.body.add(this.line(''))
    const v = h.vulnerabilities
    if (v && v.total === 0) {
      this.body.add(this.line(t`${bold('Vulnerabilities')}   ${fg(this.c.green)('none')}`))
    } else if (v) {
      this.body.add(
        this.line(
          t`${bold('Vulnerabilities')}   ${v.critical ? fg(this.c.red)(`${v.critical} critical  `) : ''}${v.high ? fg(this.c.red)(`${v.high} high  `) : ''}${v.moderate ? fg(this.c.yellow)(`${v.moderate} moderate  `) : ''}${v.low ? fg(this.c.dim)(`${v.low} low`) : ''}`,
        ),
      )
    } else {
      this.body.add(this.line(t`${bold('Vulnerabilities')}   ${fg(this.c.faint)('unavailable')}`))
    }
    this.body.add(this.line(''))
    this.body.add(
      this.line(
        t`${fg(this.c.faint)('Source: npmx.dev API (install size, vulnerabilities) + npm registry.')}`,
      ),
    )
  }

  private clearBody(): void {
    for (const child of this.body.getChildren()) this.body.remove(child)
  }

  /**
   * A body text line with the theme's base foreground applied, so uncolored
   * chunks (e.g. `bold(...)` or bare strings) stay visible in light mode
   * instead of falling back to OpenTUI's default white.
   */
  private line(content: string | StyledText): TextRenderable {
    return new TextRenderable(this.renderer, { width: '100%', fg: this.c.fg, content })
  }

  // ---------- theme ----------

  applyTheme(mode: ThemeMode): void {
    this.c = mode === 'light' ? LIGHT : DARK
    const c = this.c
    for (const bar of this.bars) bar.backgroundColor = c.bar

    this.brandText.content = this.brandContent()
    this.searchStatus.fg = c.dim
    this.searchFooterText.content = this.searchFooterContent()
    this.detailFooterText.content = this.detailFooterContent()
    this.scrollHint.fg = c.faint
    this.detailDesc.fg = c.dim
    this.detailMeta.fg = c.faint

    this.input.textColor = c.fg
    this.input.cursorColor = c.accent
    this.results.textColor = c.fg
    this.results.selectedBackgroundColor = c.selBg
    this.results.selectedTextColor = c.accent
    this.results.descriptionColor = c.faint
    this.results.selectedDescriptionColor = c.dim
    this.tabs.textColor = c.dim
    this.tabs.selectedBackgroundColor = c.selBg
    this.tabs.selectedTextColor = c.accent

    this.syntaxStyle = this.makeSyntaxStyle()
    if (this.mode === 'detail' && this.pkg) {
      this.renderHeader()
      this.renderTab()
    }
  }

  // ---------- shared ----------

  private setMode(mode: 'search' | 'detail'): void {
    this.mode = mode
    this.searchView.visible = mode === 'search'
    this.detailView.visible = mode === 'detail'
    if (mode === 'search') this.input.focus()
    else this.tabs.focus()
  }

  private setTabIndex(i: number): void {
    const tabs = this.tabs as unknown as {
      setSelectedIndex?: (n: number) => void
      selectedIndex?: number
    }
    if (typeof tabs.setSelectedIndex === 'function') tabs.setSelectedIndex(i)
    else tabs.selectedIndex = i
  }

  private updateScrollHint(): void {
    const total = this.scroll.scrollHeight
    const view = this.scroll.viewport?.height ?? this.renderer.height
    if (total > view) {
      const bottom = Math.min(this.scroll.scrollTop + view, total)
      this.scrollHint.content = t`${fg(this.c.faint)(`${bottom}/${total}`)}`
    } else {
      this.scrollHint.content = ''
    }
  }

  private onKey(key: KeyEvent): void {
    if (this.mode === 'search') this.onSearchKey(key)
    else this.onDetailKey(key)
  }

  private onSearchKey(key: KeyEvent): void {
    switch (key.name) {
      case 'up':
        this.results.moveUp()
        break
      case 'down':
        this.results.moveDown()
        break
      case 'pageup':
        this.results.moveUp(8)
        break
      case 'pagedown':
        this.results.moveDown(8)
        break
      case 'return': {
        const opt = this.results.getSelectedOption()
        const name = (opt?.value as string) ?? opt?.name
        if (name) void this.openDetail(name)
        break
      }
      case 'escape':
        if (this.input.value) {
          this.input.value = ''
          this.resultData = []
          this.results.options = []
          this.searchStatus.content = ''
        } else {
          this.renderer.destroy()
        }
        break
    }
  }

  private onDetailKey(key: KeyEvent): void {
    switch (key.name) {
      case 'escape':
        this.setMode('search')
        return
      case 'q':
        this.renderer.destroy()
        return
      case 'up':
        this.scroll.scrollBy({ x: 0, y: -2 })
        break
      case 'down':
        this.scroll.scrollBy({ x: 0, y: 2 })
        break
      case 'pageup':
        this.scroll.scrollBy(-1, 'viewport')
        break
      case 'pagedown':
      case 'space':
        this.scroll.scrollBy(1, 'viewport')
        break
      case 'home':
        this.scroll.scrollTo({ x: 0, y: 0 })
        break
      case 'end':
        this.scroll.scrollTo({ x: 0, y: this.scroll.scrollHeight })
        break
      default:
        if (key.name && key.name >= '1' && key.name <= '4') {
          const i = Number(key.name) - 1
          this.tabIndex = i
          this.setTabIndex(i)
          this.renderTab()
        }
    }
    this.updateScrollHint()
  }
}

export async function runApp(initialQuery = ''): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 })
  const forced = process.env.NPMX_THEME
  const detected = await renderer.waitForThemeMode(400)
  const theme =
    forced === 'light' || forced === 'dark' ? forced : detected === 'light' ? 'light' : 'dark'
  const app = new NpmxTui(renderer, theme)
  app.build()
  renderer.on('theme_mode', mode => app.applyTheme(mode))

  if (initialQuery) app.preloadQuery(initialQuery)

  await new Promise<void>(resolve => {
    renderer.on('destroy', () => resolve())
  })
}
