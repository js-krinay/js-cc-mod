import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import type { AgentShare, CostTypeRow, HeatCell, Pauses, TimelineEvent, TimelineSession } from './db'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { COST_TYPES, type CostType, costTypeRows, heatGrid, span, sparkPath, ticks, timelineLayout } from '@/lib/insights'
import { fmt, ms, OTHER, seriesColor, sessionName, TOP_SERIES, usd } from '@/lib/view'

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const when = (t: number, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) =>
  new Date(t).toLocaleString([], opts)
// The four token types take the first four validated slots, in order.
const typeColor = (i: number) => `var(--series-${i + 1})`

// Where the money goes, per day: a stacked bar per bucket, split by what the
// tokens were. Aqua and yellow sit under 3:1 on the light surface, so the
// legend is a table: every type's total and share, always visible.
export function CostByType({ rows, since, until, tz, bucketMs, hourly }: {
  rows: CostTypeRow[]; since: number; until: number; tz: number; bucketMs: number; hourly: boolean
}) {
  const { data, totals, total } = useMemo(() => costTypeRows(rows, since, until, tz, bucketMs, hourly), [rows, since, until, tz, bucketMs, hourly])
  const config = Object.fromEntries(COST_TYPES.map((t, i) => [t.key, { label: t.label, color: typeColor(i) }])) as ChartConfig
  return (
    <Card data-chart="cost-type">
      <CardHeader>
        <CardTitle>Cost by token type, per {hourly ? 'hour' : 'day'}</CardTitle>
        <CardDescription>What the money paid for. Cache writes and uncached input are what a longer cache life saves.</CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? <p className="py-16 text-center text-sm text-muted-foreground">No priced requests match these filters.</p> : (
          <>
            <ChartContainer config={config} className="aspect-auto h-64 w-full">
              <BarChart data={data} margin={{ left: 4, right: 4 }} barCategoryGap="22%">
                <CartesianGrid vertical={false} />
                <XAxis dataKey="bucket" tickLine={false} axisLine={false} minTickGap={24} tickFormatter={(v: string) => (hourly ? v.slice(11) : v.slice(5))} />
                <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={v => usd(v)} />
                <ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent formatter={(value, name, item) => (
                  <div className="flex w-full items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: item.color }} />
                    <span className="text-muted-foreground">{config[name as string]?.label ?? name}</span>
                    <span className="ml-auto font-medium tabular-nums">{usd(value)}</span>
                  </div>
                )} />} />
                {COST_TYPES.map((t, i) => (
                  <Bar key={t.key} dataKey={t.key} stackId="a" fill={`var(--color-${t.key})`} isAnimationActive={false}
                    stroke="var(--card)" strokeWidth={1} radius={i === COST_TYPES.length - 1 ? [4, 4, 0, 0] : 0} />
                ))}
              </BarChart>
            </ChartContainer>
            <ul className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4" aria-label="Legend">
              {COST_TYPES.map((t, i) => (
                <li key={t.key} className="flex items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: typeColor(i) }} />
                  <span className="text-muted-foreground">{t.label}</span>
                  <span className="ml-auto tabular-nums">{usd(totals[t.key])}</span>
                  <span className="w-10 text-right text-muted-foreground tabular-nums">{pct(totals[t.key] / total)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// When the requests happen: weekday by hour, in the viewer's clock.
export function HourHeatmap({ cells }: { cells: HeatCell[] }) {
  const [metric, setMetric] = useState<'requests' | 'cost'>('requests')
  const [hover, setHover] = useState<string | null>(null)
  const { rows, max } = useMemo(() => heatGrid(cells, metric), [cells, metric])
  const show = (v: number) => (metric === 'cost' ? usd(v) : fmt(v))
  return (
    <Card data-chart="heatmap">
      <CardHeader className="has-data-[slot=card-action]:grid-cols-1 sm:has-data-[slot=card-action]:grid-cols-[1fr_auto]">
        <CardTitle>When requests happen</CardTitle>
        <CardDescription>Weekday by hour, in your time zone.</CardDescription>
        <CardAction className="col-start-1 row-start-3 justify-self-start sm:col-start-2 sm:row-start-1 sm:justify-self-end">
          <ToggleGroup type="single" variant="outline" size="sm" value={metric} onValueChange={m => m && setMetric(m as typeof metric)}>
            <ToggleGroupItem value="requests" aria-label="Requests">Requests</ToggleGroupItem>
            <ToggleGroupItem value="cost" aria-label="Cost">Cost</ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <div className="grid min-w-[560px] grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-[2px]" onMouseLeave={() => setHover(null)}>
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="text-center text-[10px] text-muted-foreground tabular-nums">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>
            ))}
            {rows.map(r => [
              <span key={`l${r.dow}`} className="self-center text-xs text-muted-foreground">{r.label}</span>,
              ...r.cells.map(c => {
                const text = `${r.label} ${String(c.hour).padStart(2, '0')}:00, ${fmt(c.requests)} requests, ${usd(c.cost)}`
                return (
                  <div key={`${r.dow}:${c.hour}`} role="img" aria-label={text} data-level={c.level}
                    onMouseEnter={() => setHover(text)}
                    className="aspect-square rounded-[3px] border border-transparent hover:border-foreground"
                    style={{ background: c.level ? `var(--heat-${c.level})` : 'var(--muted)' }} />
                )
              }),
            ])}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span role="status" className="tabular-nums">{hover ?? 'Hover a cell for its hour.'}</span>
          <span className="flex items-center gap-1.5" aria-label="Scale">
            <span>less</span>
            {Array.from({ length: 6 }, (_, i) => <span key={i} className="size-3 rounded-[3px]" style={{ background: `var(--heat-${i + 1})` }} />)}
            <span>more (busiest {show(max)})</span>
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

// A part-to-whole by cost: one bar per value, biggest first, with its share
// and request count; click one to filter by it.
export function ShareBars({ id, title, description, what, rows, onPick }: {
  id: string; title: string; description: string; what: string; rows: AgentShare[]; onPick: (value: string) => void
}) {
  const total = rows.reduce((n, a) => n + a.cost, 0)
  const top = Math.max(0, ...rows.map(a => a.cost))
  return (
    <Card data-chart={id}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No requests match these filters.</p> : (
          <ul className="flex flex-col gap-1">
            {rows.map(a => (
              <li key={a.k}>
                <Button variant="ghost" onClick={() => onPick(a.k)} aria-label={`Filter by ${what} ${a.k}`}
                  className="grid h-auto w-full grid-cols-[minmax(6rem,12rem)_1fr_auto] items-center gap-3 px-1 py-1 text-left font-normal">
                  <span className="truncate" title={a.k}>{a.k}</span>
                  <span className="h-3 rounded-r-[4px] bg-[var(--series-1)]" style={{ width: `${top > 0 ? Math.max(0.5, (a.cost / top) * 100) : 0}%` }} />
                  <span className="grid grid-cols-[4.5rem_3rem_7rem] text-right tabular-nums">
                    <span>{usd(a.cost)}</span>
                    <span className="text-muted-foreground">{pct(total > 0 ? a.cost / total : null)}</span>
                    <span className="text-muted-foreground">{fmt(a.requests)} {a.requests === 1 ? 'request' : 'requests'}</span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// What idle time cost: when a thread waits longer than the cache lasts, its
// next request writes the whole context to the cache again.
export function CostOfPauses({ pauses, ttl, writeCost, onPick }: {
  pauses: Pauses; ttl: '1h' | '5m'; writeCost: number; onPick: (session: string) => void
}) {
  const life = ttl === '5m' ? '5 minutes' : 'an hour'
  return (
    <Card data-chart="pauses">
      <CardHeader>
        <CardTitle>Cost of pauses</CardTitle>
        <CardDescription>
          When a session (or a subagent) sits idle for longer than the cache lasts, here {life}, its next request writes the whole
          context to the cache again. These are those writes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {pauses.count === 0 ? (
          <p className="text-lg" data-pauses>
            No pauses longer than {life} in this period: every session picked up again while its cache was still warm.
          </p>
        ) : <p className="text-lg" data-pauses>
          <span className="font-semibold">{usd(pauses.cost)}</span> after{' '}
          <span className="font-semibold">{fmt(pauses.count)} {pauses.count === 1 ? 'pause' : 'pauses'}</span>
          {writeCost > 0 && <>, <span className="font-semibold">{pct(pauses.cost / writeCost)}</span> of all cache-write cost</>}.
        </p>}
        {pauses.top.length > 0 && (
          <Table className="min-w-[560px]">
            <TableCaption className="mt-0 mb-2 caption-top text-left text-[13px]">The costliest pauses</TableCaption>
            <TableHeader>
              <TableRow><TableHead>When</TableHead><TableHead>Session</TableHead><TableHead>Thread</TableHead>
                <TableHead className="text-right">Idle for</TableHead><TableHead className="text-right">Written again</TableHead><TableHead className="text-right">Cost</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {pauses.top.map(x => (
                <TableRow key={`${x.session}${x.at}`}>
                  <TableCell className="whitespace-nowrap">{when(x.at)}</TableCell>
                  <TableCell className="max-w-[18rem]">
                    <Button variant="link" className="block h-auto max-w-full truncate p-0 text-left font-normal text-foreground"
                      onClick={() => onPick(x.title ?? x.session)} title={sessionName(x.title, x.session)}>{sessionName(x.title, x.session)}</Button>
                  </TableCell>
                  <TableCell>{x.agent}</TableCell>
                  <TableCell className="text-right tabular-nums">{span(x.gapMs)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(x.tokens)} tokens</TableCell>
                  <TableCell className="text-right tabular-nums">{x.cost == null ? 'unpriced' : usd(x.cost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// What each recent session looked like: one row per session on a shared time
// axis, the main thread above its subagents, each request as wide as it ran.
export function SessionTimeline({ sessions, events, order, onPick, onOpen }: {
  sessions: TimelineSession[]; events: TimelineEvent[]; order: string[]; onPick: (title: string) => void; onOpen: (uid: string) => void
}) {
  const [hover, setHover] = useState<string | null>(null)
  const { start, end, marks } = useMemo(() => timelineLayout(events), [events])
  const bySession = useMemo(() => {
    const m = new Map<string, typeof marks>()
    for (const e of marks) (m.get(e.s) ?? m.set(e.s, []).get(e.s)!).push(e)
    return m
  }, [marks])
  // Models past the top TOP_SERIES share the Other grey, so they share one legend entry too.
  const models = useMemo(() => [...new Set(events.map(e => (order.indexOf(e.model) >= 0 && order.indexOf(e.model) < TOP_SERIES ? e.model : OTHER)))]
    .sort((a, b) => (a === OTHER ? 1 : b === OTHER ? -1 : order.indexOf(a) - order.indexOf(b))), [events, order])
  const sameDay = new Date(start).toDateString() === new Date(end).toDateString()
  const tickText = (t: number) => when(t, sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const describe = (e: (typeof marks)[number]) =>
    `${when(e.t, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}: ${e.agent} on ${e.model}, ${ms(e.d)}, ${e.cost == null ? 'unpriced' : usd(e.cost)}, ${pct(e.hit)} from cache`
  return (
    <Card data-chart="timeline">
      <CardHeader>
        <CardTitle>Session timeline</CardTitle>
        <CardDescription>
          The {sessions.length} most recent sessions. Top lane: main thread; bottom lane: subagents. Each mark is a request, as wide as it ran. Click a session to filter to it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? <p className="text-sm text-muted-foreground">No sessions match these filters.</p> : (
          <>
            <div className="overflow-x-auto">
              <div className="min-w-[780px]" onMouseLeave={() => setHover(null)}>
                <div className="relative ml-[13rem] h-5 text-[10px] text-muted-foreground">
                  {ticks(start, end).map((t, i, all) => (
                    <span key={t} className="absolute top-0 whitespace-nowrap tabular-nums"
                      style={{ left: `${((t - start) / Math.max(1, end - start)) * 100}%`, transform: i === 0 ? 'none' : i === all.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
                      {tickText(t)}
                    </span>
                  ))}
                </div>
                {sessions.map(s => (
                  <div key={s.id} className="flex items-stretch border-t border-border py-1.5">
                    <Button variant="ghost" onClick={() => onPick(s.title ?? s.id)} title={sessionName(s.title, s.id)}
                      className="block h-auto w-[13rem] shrink-0 truncate px-1 py-0.5 text-left font-normal">
                      <span className="block truncate">{sessionName(s.title, s.id)}</span>
                      <span className="block truncate text-xs text-muted-foreground">{fmt(s.requests)} requests, {usd(s.cost)}, {pct(s.hit)} cached</span>
                    </Button>
                    <div className="relative flex-1">
                      {[false, true].map(sub => (
                        <div key={String(sub)} className={`absolute inset-x-0 h-[45%] ${sub ? 'bottom-0' : 'top-0'} rounded-sm bg-muted/50`}>
                          {(bySession.get(s.id) ?? []).filter(e => e.sub === sub).map((e, i) => (
                            <span key={i} onMouseEnter={() => setHover(describe(e))} onClick={() => onOpen(e.uid)} data-mark
                              className="absolute inset-y-0 cursor-pointer rounded-[2px] ring-1 ring-card hover:ring-foreground"
                              style={{ left: `${e.left}%`, width: `max(3px, ${e.width}%)`, background: seriesColor(e.model, order) }} />
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span role="status" className="tabular-nums">{hover ?? 'Hover a request to read it; click it for everything logged about it.'}</span>
              <span className="flex flex-wrap gap-3" aria-label="Legend">
                {models.map(m => (
                  <span key={m} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px]" style={{ background: seriesColor(m, order) }} />{m}</span>
                ))}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// Per session, request by request: the cache hit rate (a drop is where the
// cache was lost) or the prompt size (how full the context got, main thread
// only, since each subagent has its own). One small panel per session.
export function PerSession({ sessions, events, onPick }: { sessions: TimelineSession[]; events: TimelineEvent[]; onPick: (title: string) => void }) {
  const [metric, setMetric] = useState<'hit' | 'ctx'>('hit')
  const W = 240, H = 44
  const bySession = useMemo(() => {
    const m = new Map<string, TimelineEvent[]>()
    for (const e of events) {
      if (metric === 'ctx' && e.sub) continue
      ;(m.get(e.s) ?? m.set(e.s, []).get(e.s)!).push(e)
    }
    return m
  }, [events, metric])
  // One scale for every panel, so sessions compare.
  const peak = Math.max(1, ...events.filter(e => !e.sub).map(e => e.ctx))
  return (
    <Card data-chart="cache-hit">
      <CardHeader className="has-data-[slot=card-action]:grid-cols-1 sm:has-data-[slot=card-action]:grid-cols-[1fr_auto]">
        <CardTitle>{metric === 'hit' ? 'Cache hit rate by session' : 'Context size by session'}</CardTitle>
        <CardDescription>
          {metric === 'hit'
            ? 'Share of each request\'s prompt read from cache, over the session. A drop is where the cache was lost and paid for again.'
            : 'Prompt size of each main-thread request, over the session, on one scale for all panels. A steady climb is a context worth compacting or clearing.'}
        </CardDescription>
        <CardAction className="col-start-1 row-start-3 justify-self-start sm:col-start-2 sm:row-start-1 sm:justify-self-end">
          <ToggleGroup type="single" variant="outline" size="sm" value={metric} onValueChange={m => m && setMetric(m as typeof metric)}>
            <ToggleGroupItem value="hit" aria-label="Cache hit rate">Cache hit</ToggleGroupItem>
            <ToggleGroupItem value="ctx" aria-label="Context size">Context size</ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? <p className="text-sm text-muted-foreground">No sessions match these filters.</p> : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {sessions.map(s => {
              const pts = bySession.get(s.id) ?? []
              const low = pts.filter(p => p.hit != null && p.hit < 0.5).length
              const top = Math.max(0, ...pts.map(p => p.ctx))
              const line = metric === 'hit' ? sparkPath(pts, W, H) : sparkPath(pts.map(p => ({ t: p.t, hit: p.ctx / peak })), W, H)
              return (
                <Button key={s.id} variant="outline" onClick={() => onPick(s.title ?? s.id)}
                  className="block h-auto rounded-lg p-3 text-left font-normal whitespace-normal">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm">{sessionName(s.title, s.id)}</span>
                    <span className="shrink-0 text-lg font-semibold tabular-nums">{metric === 'hit' ? pct(s.hit) : fmt(top)}</span>
                  </div>
                  <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2 h-11 w-full overflow-visible" role="img"
                    aria-label={metric === 'hit' ? `Cache hit rate across ${pts.length} requests; ${low} below half` : `Prompt size across ${pts.length} requests, peaking at ${fmt(top)} tokens`}>
                    <line x1={0} x2={W} y1={0} y2={0} className="stroke-border" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
                    <line x1={0} x2={W} y1={H} y2={H} className="stroke-border" vectorEffect="non-scaling-stroke" />
                    <path d={line} fill="none" stroke="var(--series-1)" strokeWidth={2} vectorEffect="non-scaling-stroke"
                      strokeLinejoin="round" strokeLinecap="round" />
                  </svg>
                  <div className="mt-1 flex justify-between text-xs text-muted-foreground tabular-nums">
                    <span>{fmt(pts.length)} {metric === 'ctx' ? 'main-thread ' : ''}requests</span>
                    <span>{metric === 'hit' ? (low ? `${fmt(low)} under 50%` : 'none under 50%') : `peak ${fmt(top)} tokens`}</span>
                  </div>
                </Button>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
