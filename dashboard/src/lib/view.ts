import { z } from 'zod'
import type { Sort, TableName } from '../db'
import { clamped } from '../schemas'

// Pure helpers the page draws with (tested under bun test).

export const FACET_KEYS = ['machine', 'session', 'agent', 'model', 'effort', 'branch', 'source', 'stop'] as const
export type FacetKey = (typeof FACET_KEYS)[number]
export const FACET_LABELS: Record<FacetKey, string> = {
  machine: 'Machine', session: 'Session', agent: 'Agent', model: 'Model', effort: 'Effort', branch: 'Branch',
  source: 'Source', stop: 'Outcome',
}
export const METRICS = { requests: 'Requests', output: 'Output tokens', input: 'Input tokens', cost: 'Cost (USD)' } as const
export type Metric = keyof typeof METRICS
export const TOP_SERIES = 7
export const OTHER = 'Other'

export type View = {
  days: number
  from?: string // YYYY-MM-DD, the viewer's local date
  to?: string
  q?: string
  ttl: '1h' | '5m'
  metric: Metric
  filters: Partial<Record<FacetKey, string>>
  sorts: Partial<Record<TableName, Sort>> // a table with no sort uses its default order
}

// Every table, for its `sort.<table>=<column>.<asc|desc>` hash key. The
// server checks the column against that table's own columns.
const TABLE_NAMES: readonly TableName[] = ['modelEffort', 'agent', 'machine', 'sessions', 'recent']
const SORT = /^([A-Za-z0-9]{1,40})\.(asc|desc)$/

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined)
const text = z.string().min(1).max(1000).optional().catch(undefined)
// The view lives in the URL hash, so a filtered page can be bookmarked or
// sent; anything unreadable in it falls back to its default.
const ViewHash = z.object({
  days: clamped(1, 90, 14),
  from: day,
  to: day,
  q: text,
  ttl: z.enum(['1h', '5m']).catch('1h'),
  metric: z.enum(Object.keys(METRICS) as [Metric, ...Metric[]]).catch('requests'),
  ...Object.fromEntries(FACET_KEYS.map(k => [k, text])) as Record<FacetKey, typeof text>,
})

export function readHash(hash: string): View {
  const v = ViewHash.parse(Object.fromEntries(new URLSearchParams(hash.replace(/^#/, ''))))
  const filters: View['filters'] = {}
  for (const k of FACET_KEYS) if (v[k]) filters[k] = v[k]
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const sorts: View['sorts'] = {}
  for (const t of TABLE_NAMES) {
    const m = SORT.exec(p.get(`sort.${t}`) ?? '')
    if (m) sorts[t] = { key: m[1]!, dir: m[2] as Sort['dir'] }
  }
  return { days: v.days, from: v.from, to: v.to, q: v.q, ttl: v.ttl, metric: v.metric, filters, sorts }
}

export function writeHash(v: View): string {
  const p = new URLSearchParams()
  for (const [k, val] of Object.entries(v.filters)) if (val) p.set(k, val)
  if (v.from) p.set('from', v.from)
  if (v.to) p.set('to', v.to)
  if (v.q) p.set('q', v.q)
  if (v.days !== 14) p.set('days', String(v.days))
  if (v.ttl !== '1h') p.set('ttl', v.ttl)
  if (v.metric !== 'requests') p.set('metric', v.metric)
  for (const [t, s] of Object.entries(v.sorts)) if (s) p.set(`sort.${t}`, `${s.key}.${s.dir}`)
  return p.toString()
}

const localMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const parseDay = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y!, m! - 1, d!) }

// The time window a view asks for, in the viewer's local days: the range
// starts at midnight `days - 1` days ago; explicit dates override it.
export function windowOf(v: View, now = new Date()) {
  const since = v.from ? localMidnight(parseDay(v.from)) : localMidnight(now) - (v.days - 1) * 864e5
  const until = v.to ? localMidnight(parseDay(v.to)) + 864e5 - 1 : now.getTime()
  return { since, until }
}

// Bucket b covers [b * size - tz, (b + 1) * size - tz) in UTC ms, i.e. one
// local hour or day; its label reads in the viewer's clock.
export function bucketLabel(b: number, size: number, hourly: boolean) {
  const d = new Date(b * size) // shifted by tz already, so read the UTC fields
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return hourly ? `${day} ${pad(d.getUTCHours())}:00` : day
}

export type ChartIn = { b: number; model: string; requests: number; output: number; input: number; cost: number }

// One row per bucket over the whole window (empty buckets kept, so gaps
// show), one key per series: the TOP_SERIES models by rank over the
// unfiltered range keep their own slot, the rest fold into Other. Series are
// keyed s0..s7, never by model name: the chart writes its keys into a
// stylesheet, and a model name comes from the log (or a peer).
export function chartRows(rows: ChartIn[], metric: Metric, order: string[], since: number, until: number,
  tzOffsetMin: number, size: number, hourly: boolean) {
  const own = order.slice(0, TOP_SERIES)
  const shift = tzOffsetMin * 60_000
  const first = Math.floor((since + shift) / size)
  const last = Math.floor((until + shift) / size)
  const out = new Map<number, Record<string, number | string>>()
  for (let b = first; b <= last; b++) out.set(b, { bucket: bucketLabel(b, size, hourly) })
  const used = new Set<string>()
  for (const r of rows) {
    const row = out.get(r.b)
    if (!row) continue
    const name = own.includes(r.model) ? r.model : OTHER
    row[name] = ((row[name] as number | undefined) ?? 0) + r[metric]
    if (r[metric] > 0) used.add(name)
  }
  const names = [...own, OTHER].filter(n => used.has(n))
  const key = new Map(names.map((n, i) => [n, `s${i}`]))
  const data = [...out.values()].map(row => Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k === 'bucket' ? k : key.get(k)!, v])))
  return { data, series: names.map(n => ({ key: key.get(n)!, name: n })) }
}

export const seriesColor = (name: string, order: string[]) => {
  const i = order.indexOf(name)
  return name === OTHER || i < 0 || i >= TOP_SERIES ? 'var(--series-other)' : `var(--series-${i + 1})`
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const fmt = (v: unknown) => {
  const n = num(v)
  if (n == null) return '—'
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k`
    : Math.round(n).toLocaleString()
}
export const usd = (v: unknown) => {
  const n = num(v)
  if (n == null) return '—'
  return n >= 100 ? `$${Math.round(n).toLocaleString()}` : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}`
    : n > 0 ? `$${n.toFixed(4)}` : '$0'
}
export const ms = (v: unknown) => {
  const n = num(v)
  if (n == null) return '—'
  return n >= 6e4 ? `${(n / 6e4).toFixed(1)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}s` : `${Math.round(n)}ms`
}
export const pct = (v: unknown) => { const n = num(v); return n == null ? '—' : `${(n * 100).toFixed(1)}%` }
export const metricFormat = (m: Metric) => (m === 'cost' ? usd : fmt)
