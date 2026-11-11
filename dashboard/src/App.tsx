import { ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import type { AgentShare, ChartRow, CostTypeRow, Group, HeatCell, Now, Page, Pauses, PromptRow, RecentRow, SessionRow, Sort, TableName, TimelineEvent, TimelineSession, Totals } from './db'
import { span } from '@/lib/insights'
import { RequestDrawer } from './RequestDrawer'
import { CostByType, CostOfPauses, HourHeatmap, PerSession, SessionTimeline, ShareBars } from './Insights'
import logo from './favicon.svg'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  chartRows, comparison, FACET_KEYS, sessionName, FACET_LABELS, type FacetKey, fmt, METRICS, type Metric, metricFormat, ms, OTHER, pct, readHash,
  seriesColor, usd, type View, windowOf, writeHash,
} from '@/lib/view'

type Summary = {
  kpis: Totals & { p50: number | null; p95: number | null; firstP50: number | null }
  facets: Record<FacetKey, { value: string; n: number }[]>
  modelOrder: string[]
  hourly: boolean
  bucketMs: number
  chart: ChartRow[]
  costTypes: CostTypeRow[]
  heat: HeatCell[]
  agents: AgentShare[]
  projects: AgentShare[]
  pauses: Pauses
  prev: Totals & { since: number; until: number }
  now: Now
  timeline: { sessions: TimelineSession[]; events: TimelineEvent[] }
  tables: {
    modelEffort: Page<Group>; agent: Page<Group>; machine: Page<Group>; project: Page<Group>
    sessions: Page<SessionRow>; prompts: Page<PromptRow>; recent: Page<RecentRow>
  }
  sources: { name: string; ok: boolean; rows?: number; error?: string }[]
  prices: { checked: string; basis: string }
  generatedAt: number
}

const ALL = '__all__' // a Select item cannot carry the empty string
const PAGE_SIZES = [10, 25, 50, 100]

// The query string a view asks the server for: the summary and every table page use it.
function queryParams(view: View, tz: number) {
  const { since, until } = windowOf(view)
  const p = new URLSearchParams({ since: String(since), until: String(until), tz: String(tz), ttl: view.ttl })
  for (const [k, v] of Object.entries(view.filters)) if (v) p.set(k, v)
  if (view.q) p.set('q', view.q)
  return p
}

// A table's current page: the summary's first page until the reader pages
// or sorts, then its own fetch. The sort lives in the URL; a new summary (a
// filter, a refresh) goes back to page 1 and keeps it.
function usePaged<T>(name: TableName, first: Page<T>, query: string, sort: Sort | undefined, onSort: (n: TableName, s: Sort) => void) {
  const [page, setPage] = useState(first)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async (n: number, size: number, by: Sort | undefined) => {
    const p = new URLSearchParams(query)
    p.set('name', name)
    p.set('page', String(n))
    p.set('size', String(size))
    if (by) { p.set('sort', by.key); p.set('dir', by.dir) }
    setBusy(true)
    try {
      const res = await fetch(`/api/table?${p}`, { cache: 'no-store' })
      if (res.ok) setPage((await res.json()) as Page<T>)
    } finally {
      setBusy(false)
    }
  }, [name, query])
  const latest = useRef({ load, size: page.size })
  latest.current = { load, size: page.size }
  const sortKey = sort ? `${sort.key}.${sort.dir}` : ''
  useEffect(() => {
    if (sort) void latest.current.load(1, latest.current.size, sort)
    else setPage(first)
  }, [first, sortKey]) // sortKey, not sort: the same sort read back from the URL is a new object
  const go = useCallback((n: number, size = page.size) => load(n, size, sort), [load, page.size, sort])
  // A first click sorts numbers biggest first and text A to Z; a second click flips it.
  const sortBy = useCallback((key: string, text: boolean) =>
    onSort(name, sort?.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: text ? 'asc' : 'desc' }),
  [name, onSort, sort])
  return { page, busy, go, sort, sortBy }
}

// A column header; with a key it sorts its table on the server.
type Col = { label: string; key?: string; text?: boolean; right?: boolean }

function Heads<T>({ cols, paged }: { cols: Col[]; paged: ReturnType<typeof usePaged<T>> }) {
  return (
    <TableHeader><TableRow>{cols.map(c => {
      const on = c.key !== undefined && paged.sort?.key === c.key
      const Icon = on ? (paged.sort!.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
      return (
        <TableHead key={c.label} className={c.right ? 'text-right' : ''}
          aria-sort={on ? (paged.sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
          {c.key === undefined ? c.label : (
            <Button variant="ghost" size="sm" disabled={paged.busy} onClick={() => paged.sortBy(c.key!, c.text ?? false)}
              className={`-mx-2 h-7 gap-1 px-2 font-medium ${on ? 'text-foreground' : 'text-muted-foreground'} ${c.right ? 'flex-row-reverse' : ''}`}
              aria-label={`Sort by ${c.label}`}>
              {c.label}<Icon className={`size-3.5 shrink-0 ${on ? '' : 'opacity-40'}`} aria-hidden />
            </Button>
          )}
        </TableHead>
      )
    })}</TableRow></TableHeader>
  )
}

function Pager<T>({ paged }: { paged: ReturnType<typeof usePaged<T>> }) {
  const { page, busy, go } = paged
  const pages = Math.max(1, Math.ceil(page.total / page.size))
  const from = page.total === 0 ? 0 : (page.page - 1) * page.size + 1
  const to = Math.min(page.total, page.page * page.size)
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 pt-3 text-xs text-muted-foreground" data-pager>
      <span>{fmt(from)}–{fmt(to)} of {fmt(page.total)}</span>
      <label className="flex items-center gap-2">Rows
        <Select value={String(page.size)} onValueChange={v => void go(1, Number(v))}>
          <SelectTrigger size="sm" className="h-7 w-16" aria-label="Rows per page"><SelectValue /></SelectTrigger>
          <SelectContent>{PAGE_SIZES.map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
        </Select>
      </label>
      <span>Page {page.page} of {pages}</span>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" className="h-7" disabled={busy || page.page <= 1} onClick={() => void go(page.page - 1)} aria-label="Previous page">Previous</Button>
        <Button size="sm" variant="outline" className="h-7" disabled={busy || page.page >= pages} onClick={() => void go(page.page + 1)} aria-label="Next page">Next</Button>
      </div>
    </div>
  )
}
const RANGES = [['1', 'today'], ['7', '7 days'], ['14', '14 days'], ['30', '30 days'], ['90', '90 days']] as const

export function App() {
  const [view, setView] = useState<View>(() => readHash(location.hash))
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [auto, setAuto] = useState(true)
  const [search, setSearch] = useState(view.q ?? '')
  const [detail, setDetail] = useState<string | null>(null)

  const update = useCallback((next: Partial<View> | ((v: View) => View)) => {
    setView(v => {
      const n = typeof next === 'function' ? next(v) : { ...v, ...next }
      history.replaceState(null, '', `#${writeHash(n)}`)
      return n
    })
  }, [])
  const setFilter = useCallback((k: FacetKey, value?: string) =>
    update(v => ({ ...v, filters: { ...v.filters, [k]: value || undefined } })), [update])

  useEffect(() => {
    const on = () => setView(readHash(location.hash))
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  // Search waits for a pause in typing, so each keystroke is not a query.
  useEffect(() => {
    const t = setTimeout(() => { if ((search || undefined) !== view.q) update({ q: search || undefined }) }, 300)
    return () => clearTimeout(t)
  }, [search, view.q, update])

  const tz = -new Date().getTimezoneOffset()
  // The summary's query is rebuilt only when the view changes apart from its
  // sorts: it reads the clock for its window, so rebuilding it on a sort would
  // look like a new query and reload the page.
  const viewKey = writeHash({ ...view, sorts: {} })
  const query = useMemo(() => queryParams(view, tz).toString(), [viewKey, tz])
  const onSort = useCallback((t: TableName, sort: Sort) => update(v => ({ ...v, sorts: { ...v.sorts, [t]: sort } })), [update])
  const latest = useRef(0)
  const load = useCallback(async () => {
    const p = query
    const id = ++latest.current
    setLoading(true)
    try {
      const res = await fetch(`/api/summary?${p}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as Summary
      if (id === latest.current) { setData(body); setError(null) }
    } catch (e) {
      if (id === latest.current) setError((e as Error).message)
    } finally {
      if (id === latest.current) setLoading(false)
    }
  }, [query])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!auto) return
    const t = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    return () => clearInterval(t)
  }, [auto, load])

  const active = Object.values(view.filters).some(Boolean) || !!view.from || !!view.to || !!view.q
  const clear = () => { setSearch(''); update(v => ({ ...v, filters: {}, from: undefined, to: undefined, q: undefined })) }

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col px-4 pt-5 pb-16 sm:px-8 *:min-w-0">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <img src={logo} alt="" className="size-6" />
        <span className="font-semibold">Request log</span>
        <p className="min-w-60 flex-1 text-[13px] text-muted-foreground" role="status">
          {error ? <span className="text-destructive">Could not load the log: {error}. It retries on the next refresh.</span>
            : data ? <Sources sources={data.sources} at={data.generatedAt} /> : 'Loading the log…'}
        </p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch id="auto-refresh" checked={auto} onCheckedChange={setAuto} />
            <Label htmlFor="auto-refresh" className="text-[13px] font-normal text-muted-foreground">Refresh every minute</Label>
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>
      </header>

      {data && <NowStrip now={data.now} at={data.generatedAt} />}

      <div className="flex flex-col gap-4 pt-8 pb-8">
        {data ? <Statement data={data} view={view} onDays={d => update({ days: d })} /> : <p className="h-24" />}
        {data && <p className="max-w-[64ch] text-lg text-muted-foreground" data-comparison>{comparison(data.kpis, data.prev, view, data.prev.until - data.prev.since)}</p>}
        {data && (
          <div className="flex max-w-[80ch] flex-col gap-1 text-[13px] text-muted-foreground">
            <p>List prices as of {data.prices.checked}, global routing, standard speed. A Claude subscription is not billed per token.</p>
            <p className="flex flex-wrap items-center gap-x-1.5">
              Cache writes are priced at
              <Select value={view.ttl} onValueChange={t => update({ ttl: t as View['ttl'] })}>
                <SelectTrigger size="sm" className="h-6 w-auto px-2 text-[13px]" aria-label="Cache write rate"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1h">the 1-hour rate</SelectItem>
                  <SelectItem value="5m">the 5-minute rate</SelectItem>
                </SelectContent>
              </Select>
              because the log does not record which one a write used.
            </p>
          </div>
        )}
      </div>

      <section aria-label="Filters" className="flex flex-wrap items-end gap-x-3 gap-y-3 pb-8">
        {FACET_KEYS.map(k => {
          const options = data?.facets[k] ?? []
          const current = view.filters[k]
          const list = current && !options.some(o => o.value === current) ? [{ value: current, n: 0 }, ...options] : options
          return (
            <div key={k} className="flex min-w-0 flex-col gap-1">
              <Label className="text-[13px] font-normal text-muted-foreground" htmlFor={`f-${k}`}>{FACET_LABELS[k]}</Label>
              <Select value={current ?? ALL} onValueChange={v => setFilter(k, v === ALL ? undefined : v)}>
                <SelectTrigger id={`f-${k}`} size="sm" className="w-40 max-w-[44vw]" data-facet={k}><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value={ALL}>All</SelectItem>
                  {list.map(o => <SelectItem key={o.value} value={o.value}><span className="max-w-72 truncate">{o.value}</span> <span className="text-muted-foreground">({fmt(o.n)})</span></SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )
        })}
        <div className="flex flex-col gap-1">
          <Label className="text-[13px] font-normal text-muted-foreground" htmlFor="from">From</Label>
          <Input id="from" type="date" className="h-8 w-36" value={view.from ?? ''} onChange={e => update({ from: e.target.value || undefined })} />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-[13px] font-normal text-muted-foreground" htmlFor="to">To</Label>
          <Input id="to" type="date" className="h-8 w-36" value={view.to ?? ''} onChange={e => update({ to: e.target.value || undefined })} />
        </div>
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <Label className="text-[13px] font-normal text-muted-foreground" htmlFor="q">Search</Label>
          <Input id="q" type="search" className="h-8" placeholder="Session title, folder, branch or task" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Button size="sm" variant="ghost" onClick={clear} disabled={!active}><X /> Clear filters</Button>
      </section>

      {data && (
        <>
          <Section id="money" title="Where the money went" aside={<Figures items={[
            ['Output tokens', fmt(data.kpis.output)], ['Uncached input', fmt(data.kpis.input)],
            ['Cache read', fmt(data.kpis.cacheRead)], ['Cache write', fmt(data.kpis.cacheWrite)],
            ...(data.kpis.unpriced ? [['Unpriced requests', fmt(data.kpis.unpriced)] as [string, string]] : []),
          ]} />}>
            <Chart data={data} view={view} tz={tz} onMetric={m => update({ metric: m })}
              onDay={d => update({ from: d, to: d })} onModel={m => setFilter('model', m)} />
            <CostByType rows={data.costTypes} {...windowOf(view)} tz={tz} bucketMs={data.bucketMs} hourly={data.hourly} />
            <CostOfPauses pauses={data.pauses} ttl={view.ttl} writeCost={data.costTypes.reduce((n, c) => n + c.cacheWrite, 0)}
              onPick={t => setFilter('session', t)} />
            <div className="max-w-[880px]">
              <ShareBars id="project-share" title="Spend by project" what="project" rows={data.projects} onPick={v => setFilter('project', v)}
                description="Each project is the folder Claude Code ran in; a worktree counts under the project that holds it. Click one to filter by it." />
            </div>
          </Section>

          <Section id="when" title="When you work" aside={<Figures items={[
            ['Typical request', ms(data.kpis.p50)], ['Slowest 5% take', ms(data.kpis.p95)],
            ['First token, typical', ms(data.kpis.firstP50)], ['No response', fmt(data.kpis.noResponse)],
          ]} />}>
            <div className="max-w-[880px]"><HourHeatmap cells={data.heat} /></div>
          </Section>

          <Section id="sessions" title="Sessions" aside={<Figures items={[
            ['Sessions', fmt(data.kpis.sessions)], ['Prompt read from cache', pct(cacheShare(data.kpis))],
          ]} />}>
            <SessionTimeline sessions={data.timeline.sessions} events={data.timeline.events} order={data.modelOrder} onPick={t => setFilter('session', t)} onOpen={setDetail} />
            <PerSession sessions={data.timeline.sessions} events={data.timeline.events} onPick={t => setFilter('session', t)} />
            <Prompts first={data.tables.prompts} query={query} sorts={view.sorts} onSort={onSort} onPick={t => setFilter('session', t)} />
            <Sessions first={data.tables.sessions} query={query} sorts={view.sorts} onSort={onSort} onPick={s => setFilter('session', s.title ?? s.k)} />
          </Section>

          <Section id="who" title="Who did the work">
            <div className="max-w-[880px]">
              <ShareBars id="agent-share" title="Subagent share of cost" what="agent" rows={data.agents} onPick={a => setFilter('agent', a)}
                description="The main thread against each subagent type. Click one to filter by it." />
            </div>
            <GroupTable name="modelEffort" title="By model and effort" first={data.tables.modelEffort} query={query} sorts={view.sorts} onSort={onSort}
              head={[{ label: 'Model', key: 'k', text: true }, { label: 'Effort' }]} cells={g => { const [m, e] = g.k.split('\u0000'); return [<Swatch key="m" name={m!} order={data.modelOrder} />, e] }}
              onPick={g => { const [m, e] = g.k.split('\u0000'); update(v => ({ ...v, filters: { ...v.filters, model: m, effort: e } })) }} />
            <div className="grid gap-10 xl:grid-cols-2 *:min-w-0">
              <GroupTable name="agent" title="By agent" first={data.tables.agent} query={query} sorts={view.sorts} onSort={onSort} head={[{ label: 'Agent', key: 'k', text: true }]} cells={g => [g.k]} onPick={g => setFilter('agent', g.k)} />
              <GroupTable name="project" title="By project" first={data.tables.project} query={query} sorts={view.sorts} onSort={onSort} head={[{ label: 'Project', key: 'k', text: true }]} cells={g => [g.k]} onPick={g => setFilter('project', g.k)} />
              <GroupTable name="machine" title="By machine" first={data.tables.machine} query={query} sorts={view.sorts} onSort={onSort} head={[{ label: 'Machine', key: 'k', text: true }]} cells={g => [g.k]} onPick={g => setFilter('machine', g.k)} />
            </div>
          </Section>

          <Section id="requests" title="Every request">
            <Recent first={data.tables.recent} query={query} sorts={view.sorts} onSort={onSort} order={data.modelOrder} onOpen={setDetail} />
          </Section>
          <RequestDrawer uid={detail} ttl={view.ttl} order={data.modelOrder} onOpen={setDetail} onClose={() => setDetail(null)} />
        </>
      )}
    </div>
  )
}

const cacheShare = (k: Totals) => { const sent = k.input + k.cacheRead + k.cacheWrite; return sent ? k.cacheRead / sent : null }
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`

// The page's reading for the period, as a sentence. The period inside it is
// the range control, so the sentence is also how you change it.
function Statement({ data, view, onDays }: { data: Summary; view: View; onDays: (d: number) => void }) {
  const k = data.kpis
  const machines = data.facets.machine.filter(f => f.n > 0).length
  const fig = 'font-semibold'
  const range = view.from || view.to
    ? <>Between <span className={fig}>{view.from ?? 'the start'}</span> and <span className={fig}>{view.to ?? 'today'}</span>,</>
    : <>
        {view.days === 1 ? '' : 'In the last '}
        <Select value={String(view.days)} onValueChange={d => onDays(Number(d))}>
          <SelectTrigger aria-label="Range" className="inline-flex h-auto w-auto gap-1 rounded-none border-0 border-b-2 border-foreground/30 bg-transparent px-0.5 py-0 font-semibold [font-size:inherit] shadow-none hover:border-foreground focus-visible:ring-2 dark:bg-transparent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>{RANGES.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
        </Select>,
      </>
  return (
    <p className="max-w-[64ch] text-[clamp(1.375rem,0.9rem+1.6vw,2.125rem)] leading-[1.3] font-light text-balance" data-statement>
      {range} Claude answered <span className={fig} data-kpi="requests">{plural(k.requests, 'request')}</span> in{' '}
      <span className={fig}>{plural(k.sessions, 'session')}</span> on <span className={fig}>{plural(machines, 'machine')}</span>, worth{' '}
      <span className={fig} data-kpi="cost">{usd(k.cost)}</span> at list price.{' '}
      {cacheShare(k) != null && <><span className={fig}>{Math.round(cacheShare(k)! * 100)}%</span> of the prompt came from cache.</>}
    </p>
  )
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// What is happening now, whatever the filters below: the estimated 5-hour
// usage window, the sessions working in the last ten minutes, the last
// request and today so far.
function NowStrip({ now, at }: { now: Now; at: number }) {
  const w = now.window
  const item = (label: string, value: React.ReactNode, detail: React.ReactNode, key: string) => (
    <div className="flex min-w-0 flex-col gap-0.5" data-now={key}>
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="truncate font-semibold">{value}</span>
      <span className="text-[13px] text-pretty break-words text-muted-foreground">{detail}</span>
    </div>
  )
  return (
    <section aria-label="Right now, across every machine whatever the filters" className="mt-6 grid gap-x-8 gap-y-4 border-y border-border py-4 sm:grid-cols-2 xl:grid-cols-4">
      {item('This 5-hour window (estimated from the log)',
        w ? <>{usd(w.cost)} for {plural(w.requests, 'request')}, {plural(w.prompts, 'prompt')}</> : 'No window open',
        w ? `Opened ${clock(w.start)}; runs out at ${clock(w.resets)}, in ${span(w.resets - at)}` : 'One opens with your next request', 'window')}
      {item('Working now', now.active.length ? plural(now.active.length, 'session') : 'Nothing running',
        now.active.length ? now.active.map(x => sessionName(x.title, x.id)).join(', ') : 'No request in the last 10 minutes', 'active')}
      {item('Last request', now.last ? `${span(Math.max(0, at - now.last.at))} ago` : 'None yet',
        now.last ? `${now.last.model} in ${sessionName(now.last.title, now.last.session)}${now.last.machine ? `, on ${now.last.machine}` : ''}` : 'Nothing logged yet', 'last')}
      {item('Today so far', usd(now.today.cost), plural(now.today.requests, 'request'), 'today')}
    </section>
  )
}

function Sources({ sources, at }: { sources: Summary['sources']; at: number }) {
  const down = sources.filter(s => !s.ok)
  const names = (l: typeof sources) => l.map(s => s.name).join(' and ')
  return (
    <>
      {down.length === 0 ? `${names(sources)} ${sources.length === 1 ? 'is' : 'are'} in sync.` : (
        <span className="text-destructive">{names(down)} could not be reached; its requests may be missing.</span>
      )} Updated {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
    </>
  )
}

// A part of the page: its question on the left with the figures that answer
// it, the charts and tables on the right. Below lg the two stack.
function Section({ id, title, aside, children }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-6 border-t border-border py-10 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-12">
      <div className="flex flex-col gap-5 lg:sticky lg:top-6 lg:self-start">
        <h2 id={id} className="text-xl leading-tight font-semibold text-balance">{title}</h2>
        {aside}
      </div>
      <div className="flex min-w-0 flex-col gap-12">{children}</div>
    </section>
  )
}

function Figures({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 lg:grid-cols-1">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-[13px] text-muted-foreground">{k}</dt>
          <dd className="text-lg font-semibold whitespace-nowrap" data-kpi={k}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Chart({ data, view, tz, onMetric, onDay, onModel }: {
  data: Summary; view: View; tz: number; onMetric: (m: Metric) => void; onDay: (d: string) => void; onModel: (m: string) => void
}) {
  const { since, until } = windowOf(view)
  const { data: rows, series } = useMemo(() => chartRows(data.chart, view.metric, data.modelOrder, since, until, tz,
    data.bucketMs, data.hourly), [data, view.metric, since, until, tz])
  const config = useMemo(() => Object.fromEntries(series.map(s => [s.key, { label: s.name, color: seriesColor(s.name, data.modelOrder) }])) as ChartConfig,
    [series, data.modelOrder])
  const format = metricFormat(view.metric)
  return (
    <Card>
      <CardHeader className="has-data-[slot=card-action]:grid-cols-1 sm:has-data-[slot=card-action]:grid-cols-[1fr_auto]">
        <CardTitle>{METRICS[view.metric]} per {data.hourly ? 'hour' : 'day'}, by model</CardTitle>
        <CardDescription>Click a {data.hourly ? 'bar to see that hour\'s requests below' : 'day to filter to it'}, or a model to filter by it.</CardDescription>
        <CardAction className="col-start-1 row-start-3 justify-self-start sm:col-start-2 sm:row-start-1 sm:justify-self-end">
          <ToggleGroup type="single" variant="outline" size="sm" value={view.metric} onValueChange={m => m && onMetric(m as Metric)}>
            {Object.entries(METRICS).map(([k, l]) => <ToggleGroupItem key={k} value={k} data-metric={k} aria-label={l}>{l.split(' ')[0]}</ToggleGroupItem>)}
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        {series.length === 0 ? <p className="py-16 text-center text-sm text-muted-foreground">No requests match these filters.</p> : (
          <>
            <ChartContainer config={config} className="aspect-auto h-64 w-full">
              <BarChart data={rows} margin={{ left: 4, right: 4 }} barCategoryGap="22%"
                onClick={e => { const label = (e as { activeLabel?: string })?.activeLabel; if (label && !data.hourly) onDay(label) }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="bucket" tickLine={false} axisLine={false} minTickGap={24}
                  tickFormatter={(v: string) => (data.hourly ? v.slice(11) : v.slice(5))} />
                <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={v => format(v)} />
                <ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent formatter={(value, name, item) => (
                  <div className="flex w-full items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: item.color }} />
                    <span className="text-muted-foreground">{name}</span>
                    <span className="ml-auto font-medium tabular-nums">{format(value)}</span>
                  </div>
                )} />} />
                {series.map((s, i) => (
                  <Bar key={s.key} dataKey={s.key} name={s.name} stackId="a" fill={`var(--color-${s.key})`} isAnimationActive={false}
                    stroke="var(--card)" strokeWidth={1} radius={i === series.length - 1 ? [4, 4, 0, 0] : 0} />
                ))}
              </BarChart>
            </ChartContainer>
            <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Legend">
              {series.map(s => (
                <Button key={s.key} variant="outline" size="sm" className="h-7 text-xs" disabled={s.name === OTHER} onClick={() => onModel(s.name)} data-model={s.name}>
                  <span className="size-2.5 rounded-[3px]" style={{ background: seriesColor(s.name, data.modelOrder) }} />{s.name}
                </Button>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

const Swatch = ({ name, order }: { name: string; order: string[] }) => (
  <span className="inline-flex items-center gap-2"><span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: seriesColor(name, order) }} />{name}</span>
)

const TOKEN_COLS: Col[] = [['Requests', 'requests'], ['Cost', 'cost'], ['Input', 'input'], ['Cache read', 'cacheRead'],
  ['Cache write', 'cacheWrite'], ['Output', 'output'], ['p50', 'p50'], ['p95', 'p95']].map(([label, key]) => ({ label: label!, key, right: true }))
const tokenCells = (g: Group) => [fmt(g.requests), usd(g.cost) + (g.unpriced ? '*' : ''), fmt(g.input), fmt(g.cacheRead),
  fmt(g.cacheWrite), fmt(g.output), ms(g.p50), ms(g.p95)]

function Pickable({ onPick, children }: { onPick?: () => void; children: React.ReactNode }) {
  return onPick ? (
    <TableRow tabIndex={0} className="cursor-pointer" onClick={onPick} onKeyDown={e => { if (e.key === 'Enter') onPick() }}>{children}</TableRow>
  ) : <TableRow>{children}</TableRow>
}

function GroupTable({ name, title, first, query, sorts, onSort, head, cells, onPick }: {
  name: TableName; title: string; first: Page<Group>; query: string; sorts: View['sorts']; onSort: (n: TableName, s: Sort) => void; head: Col[]
  cells: (g: Group) => React.ReactNode[]; onPick: (g: Group) => void
}) {
  const paged = usePaged(name, first, query, sorts[name], onSort)
  const groups = paged.page.rows
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>Click a row to filter by it, a column to sort. * includes unpriced requests.</CardDescription></CardHeader>
      <CardContent>
        {groups.length === 0 ? <p className="text-sm text-muted-foreground">Nothing here.</p> : (
          <Table>
            <Heads cols={[...head, ...TOKEN_COLS]} paged={paged} />
            <TableBody>
              {groups.map(g => (
                <Pickable key={g.k} onPick={() => onPick(g)}>
                  {cells(g).map((c, i) => <TableCell key={i}>{c}</TableCell>)}
                  {tokenCells(g).map((c, i) => <TableCell key={`t${i}`} className="text-right tabular-nums">{c}</TableCell>)}
                </Pickable>
              ))}
            </TableBody>
          </Table>
        )}
        <Pager paged={paged} />
      </CardContent>
    </Card>
  )
}

function Sessions({ first, query, sorts, onSort, onPick }: {
  first: Page<SessionRow>; query: string; sorts: View['sorts']; onSort: (n: TableName, s: Sort) => void; onPick: (s: SessionRow) => void
}) {
  const paged = usePaged('sessions', first, query, sorts.sessions, onSort)
  const rows = paged.page.rows
  return (
    <Card>
      <CardHeader><CardTitle>Sessions</CardTitle><CardDescription>Click a session to filter to it, a column to sort.</CardDescription></CardHeader>
      <CardContent>
        <Table>
          <Heads paged={paged} cols={[
            { label: 'Session', key: 'title', text: true }, { label: 'Last request', key: 'last' },
            { label: 'Requests', key: 'requests', right: true }, { label: 'Cost', key: 'cost', right: true },
            { label: 'Output', key: 'output', right: true }, { label: 'Cache read', key: 'cacheRead', right: true },
          ]} />
          <TableBody>
            {rows.map(s => (
              <Pickable key={s.k} onPick={() => onPick(s)}>
                <TableCell><div className="max-w-[420px] truncate">{sessionName(s.title, s.k)}</div><div className="text-xs text-muted-foreground">{s.machine}{s.branch ? `, on ${s.branch}` : ''}</div></TableCell>
                <TableCell>{s.last ? new Date(s.last).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(s.requests)}</TableCell>
                <TableCell className="text-right tabular-nums">{usd(s.cost)}{s.unpriced ? '*' : ''}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(s.output)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(s.cacheRead)}</TableCell>
              </Pickable>
            ))}
          </TableBody>
        </Table>
        <Pager paged={paged} />
      </CardContent>
    </Card>
  )
}

// One row per prompt you sent: its requests (subagents included), what it
// cost, how long it took, and how big the context got.
function Prompts({ first, query, sorts, onSort, onPick }: {
  first: Page<PromptRow>; query: string; sorts: View['sorts']; onSort: (n: TableName, s: Sort) => void; onPick: (title: string) => void
}) {
  const paged = usePaged('prompts', first, query, sorts.prompts, onSort)
  const rows = paged.page.rows
  return (
    <Card>
      <CardHeader>
        <CardTitle>Prompts</CardTitle>
        <CardDescription>
          Each prompt you sent and every request it set off. A subagent request counts under the prompt that was running when it started.
          Peak context is the largest main-thread prompt. Click a row to filter to its session, a column to sort.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No prompts match these filters.</p> : (
          <Table>
            <Heads paged={paged} cols={[
              { label: 'Sent', key: 'started' }, { label: 'Session', key: 'title', text: true },
              { label: 'Requests', key: 'requests', right: true }, { label: 'By subagents', key: 'subagents', right: true },
              { label: 'Cost', key: 'cost', right: true }, { label: 'Output', key: 'output', right: true },
              { label: 'Took', key: 'duration', right: true }, { label: 'Peak context', key: 'peak', right: true },
            ]} />
            <TableBody>
              {rows.map(p => (
                <Pickable key={`${p.session}${p.k}`} onPick={() => onPick(p.title ?? p.session)}>
                  <TableCell className="whitespace-nowrap">{new Date(p.started).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</TableCell>
                  <TableCell><div className="max-w-[320px] truncate">{sessionName(p.title, p.session)}</div></TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(p.requests)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(p.subagents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(p.cost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(p.output)}</TableCell>
                  <TableCell className="text-right tabular-nums">{span(p.durationMs)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(p.peak)}</TableCell>
                </Pickable>
              ))}
            </TableBody>
          </Table>
        )}
        <Pager paged={paged} />
      </CardContent>
    </Card>
  )
}

function Recent({ first, query, sorts, onSort, order, onOpen }: {
  first: Page<RecentRow>; query: string; sorts: View['sorts']; onSort: (n: TableName, s: Sort) => void; order: string[]; onOpen: (uid: string) => void
}) {
  const paged = usePaged('recent', first, query, sorts.recent, onSort)
  const rows = paged.page.rows
  return (
    <Card>
      <CardHeader><CardTitle>Requests</CardTitle><CardDescription>Newest first. Click a request for everything logged about it, a column to sort.</CardDescription></CardHeader>
      <CardContent>
        <Table>
          <Heads paged={paged} cols={[
            { label: 'Time', key: 'time' }, { label: 'Session', key: 'session', text: true }, { label: 'Agent', key: 'agent', text: true },
            { label: 'Model', key: 'model', text: true }, { label: 'Effort', key: 'effort', text: true },
            { label: 'Input (all)', key: 'input', right: true }, { label: 'Output', key: 'output', right: true },
            { label: 'Cost', key: 'cost', right: true }, { label: 'Duration', key: 'duration', right: true },
            { label: 'Outcome', key: 'outcome', text: true },
          ]} />
          <TableBody>
            {rows.map(r => (
              <Pickable key={r.uid} onPick={() => onOpen(r.uid)}>
                <TableCell>{new Date(r.ended_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</TableCell>
                <TableCell><div className="max-w-[260px] truncate">{r.session_title ?? r.session_id}</div></TableCell>
                <TableCell><div className="max-w-[260px] truncate">{r.agent_id ? `${r.agent_type ?? 'subagent'}: ${r.agent_description ?? ''}` : 'main'}</div></TableCell>
                <TableCell><Swatch name={r.model} order={order} /></TableCell>
                <TableCell>{r.effort ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.input_all)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(r.output_tokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.cost == null ? 'unpriced' : usd(r.cost)}</TableCell>
                <TableCell className="text-right tabular-nums">{ms(r.duration_ms)}</TableCell>
                <TableCell>{r.outcome}</TableCell>
              </Pickable>
            ))}
          </TableBody>
        </Table>
        <Pager paged={paged} />
      </CardContent>
    </Card>
  )
}
