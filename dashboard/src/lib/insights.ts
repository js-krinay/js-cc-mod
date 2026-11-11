import type { CostTypeRow, HeatCell, TimelineEvent } from '../db'
import { bucketLabel } from './view'

// Pure helpers for the usage charts (tested under bun test).

export const COST_TYPES = [
  { key: 'input', label: 'Uncached input' },
  { key: 'cacheWrite', label: 'Cache write' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'output', label: 'Output' },
] as const
export type CostType = (typeof COST_TYPES)[number]['key']

// One row per bucket over the whole window, empty buckets kept so gaps show.
export function costTypeRows(rows: CostTypeRow[], since: number, until: number, tzOffsetMin: number, size: number, hourly: boolean) {
  const shift = tzOffsetMin * 60_000
  const by = new Map(rows.map(r => [r.b, r]))
  const out: ({ bucket: string } & Record<CostType, number>)[] = []
  for (let b = Math.floor((since + shift) / size); b <= Math.floor((until + shift) / size); b++) {
    const r = by.get(b)
    out.push({ bucket: bucketLabel(b, size, hourly), input: r?.input ?? 0, cacheWrite: r?.cacheWrite ?? 0, cacheRead: r?.cacheRead ?? 0, output: r?.output ?? 0 })
  }
  const totals = Object.fromEntries(COST_TYPES.map(t => [t.key, out.reduce((n, r) => n + r[t.key], 0)])) as Record<CostType, number>
  return { data: out, totals, total: Object.values(totals).reduce((a, b) => a + b, 0) }
}

// Weekdays from Monday, as a working week reads.
export const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']] as const
export const HEAT_LEVELS = 6

// A 7 x 24 grid (Monday first) with each cell's value and its level on the
// sequential ramp: 0 for nothing, 1..HEAT_LEVELS by share of the busiest cell.
export function heatGrid(cells: HeatCell[], metric: 'requests' | 'cost') {
  const at = new Map(cells.map(c => [`${c.dow}:${c.hour}`, c]))
  const max = Math.max(0, ...cells.map(c => c[metric]))
  const rows = WEEKDAYS.map(([dow, label]) => ({
    dow, label,
    cells: Array.from({ length: 24 }, (_, hour) => {
      const c = at.get(`${dow}:${hour}`)
      const value = c?.[metric] ?? 0
      return { hour, value, requests: c?.requests ?? 0, cost: c?.cost ?? 0, level: value > 0 && max > 0 ? Math.max(1, Math.ceil((value / max) * HEAT_LEVELS)) : 0 }
    }),
  }))
  return { rows, max }
}

// Where each request sits on the shared timeline, as a percentage of the
// track: it spans from its start (end minus duration) to its end.
export function timelineLayout(events: TimelineEvent[]) {
  if (events.length === 0) return { start: 0, end: 0, marks: [] as (TimelineEvent & { left: number; width: number })[] }
  const start = Math.min(...events.map(e => e.t - (e.d ?? 0)))
  const end = Math.max(...events.map(e => e.t))
  const span = Math.max(1, end - start)
  const marks = events.map(e => {
    const from = e.t - (e.d ?? 0)
    return { ...e, left: ((from - start) / span) * 100, width: (((e.d ?? 0)) / span) * 100 }
  })
  return { start, end, marks }
}

// Evenly spaced axis ticks across [start, end].
export function ticks(start: number, end: number, n = 5) {
  if (end <= start) return [start]
  return Array.from({ length: n }, (_, i) => start + ((end - start) * i) / (n - 1))
}

// An SVG path through a session's per-request cache hit rates, in a w x h
// box (y = 0 at the bottom). A request with no rate breaks the line.
export function sparkPath(points: { t: number; hit: number | null }[], w: number, h: number) {
  const known = points.filter(p => p.hit != null)
  if (known.length === 0) return ''
  if (known.length === 1) { // one rate: a flat line, so it still shows
    const y = (h - Math.min(1, Math.max(0, known[0]!.hit!)) * h).toFixed(1)
    return `M0.0,${y}L${w.toFixed(1)},${y}`
  }
  const t0 = Math.min(...points.map(p => p.t))
  const span = Math.max(1, Math.max(...points.map(p => p.t)) - t0)
  const x = (t: number) => (points.length === 1 ? w / 2 : ((t - t0) / span) * w)
  let d = ''
  let pen = false
  for (const p of points) {
    if (p.hit == null) { pen = false; continue }
    const y = h - Math.min(1, Math.max(0, p.hit)) * h
    d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y.toFixed(1)}`
    pen = true
  }
  return d
}

// An idle length in the two largest units that fit: 45s, 12m, 2h 10m, 2d 3h.
export function span(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`
}
