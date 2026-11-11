import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pricesFile from '../prices.json'
import { PricesFile } from '../src/schemas'
import { Database } from 'bun:sqlite'
import { COLUMNS, exportRows, ingest, insertRows, open, priceKey, SORTS, summary, syncPeer, table, TABLES, type Query } from '../src/db'

const prices = PricesFile.parse(pricesFile)
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'rl-')); dirs.push(d); return d }

const T0 = Date.parse('2026-11-12T10:00:00Z')
const line = (over: Record<string, unknown> = {}) => JSON.stringify({
  endedAt: new Date(T0).toISOString(), durationMs: 1000, firstChunkMs: 300, machine: 'mac', sessionId: 's1',
  sessionTitle: 'Ticket work', model: 'claude-opus-5-5', modelAnswered: 'claude-opus-5-5', effort: 'high',
  stopReason: 'end_turn', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  tools: ['Bash'], source: 'turn.step', branch: 'main', ...over,
}) + '\n'

const setup = () => {
  const d = tmp()
  const db = open(join(d, 'index.sqlite'), prices)
  return { d, db, logs: d }
}
const q = (over: Partial<Query> = {}): Query => ({
  since: T0 - 30 * 864e5, until: T0 + 864e5, tzOffsetMin: 0, ttl: '1h', filters: {}, ...over,
})

describe('ingest', () => {
  test('reads each file once, waits for a line still being written, and skips bad lines', async () => {
    const { d, db } = setup()
    const f = join(d, '2026-11-12.jsonl')
    writeFileSync(f, line() + '{not json\n' + line({ sessionId: 's2' }).slice(0, 40))
    expect(await ingest(db, d, 'mac', prices.models)).toEqual({ added: 1, skipped: 1 })
    appendFileSync(f, line({ sessionId: 's2' }).slice(40))
    expect((await ingest(db, d, 'mac', prices.models)).added).toBe(1)
    expect((await ingest(db, d, 'mac', prices.models)).added).toBe(0)
    writeFileSync(join(d, 'notes.jsonl'), line({ sessionId: 'ignored' }))
    expect((await ingest(db, d, 'mac', prices.models)).added).toBe(0)
    expect(summary(db, q()).kpis.requests).toBe(2)
  })

  test('multi-byte text keeps byte offsets exact', async () => {
    const { d, db } = setup()
    const f = join(d, '2026-11-12.jsonl')
    writeFileSync(f, line({ sessionTitle: 'Évènements – 日本' }))
    await ingest(db, d, 'mac', prices.models)
    appendFileSync(f, line({ sessionId: 's2' }))
    expect((await ingest(db, d, 'mac', prices.models)).added).toBe(1)
    expect(summary(db, q()).tables.sessions.rows.map(s => s.title).sort()).toEqual(['Ticket work', 'Évènements – 日本'])
  })

  test('a missing log folder is empty, not an error', async () => {
    const { db } = setup()
    expect(await ingest(db, '/nonexistent/request-log', 'mac', prices.models)).toEqual({ added: 0, skipped: 0 })
  })
})

describe('cost', () => {
  const costOf = async (over: Record<string, unknown>, ttl: '1h' | '5m' = '1h') => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), line(over))
    await ingest(db, d, 'mac', prices.models)
    return summary(db, q({ ttl })).kpis
  }

  test('a million input tokens on Opus 5.5 is $4, and output, reads and writes use their own rates', async () => {
    expect((await costOf({})).cost).toBeCloseTo(4)
    expect((await costOf({ inputTokens: 0, outputTokens: 1_000_000 })).cost).toBeCloseTo(20)
    expect((await costOf({ inputTokens: 0, cacheReadTokens: 1_000_000 })).cost).toBeCloseTo(0.2)
    expect((await costOf({ inputTokens: 0, cacheWriteTokens: 1_000_000 })).cost).toBeCloseTo(8)
    expect((await costOf({ inputTokens: 0, cacheWriteTokens: 1_000_000 }, '5m')).cost).toBeCloseTo(5)
  })

  test('Haiku 5.5 pays its higher rates on the whole request once the prompt passes 100,000 tokens', async () => {
    const base = { model: 'claude-haiku-5-5', modelAnswered: 'claude-haiku-5-5', outputTokens: 10_000 }
    expect((await costOf({ ...base, inputTokens: 100_000 })).cost).toBeCloseTo((100_000 * 0.1 + 10_000 * 0.5) / 1e6)
    // 60k uncached + 50k cache read = 110k prompt: over the line.
    expect((await costOf({ ...base, inputTokens: 60_000, cacheReadTokens: 50_000 })).cost)
      .toBeCloseTo((60_000 * 0.5 + 50_000 * 0.05 + 10_000 * 2.5) / 1e6)
  })

  test('an unknown model is unpriced; a request with no usage costs nothing', async () => {
    const unknown = await costOf({ model: 'gpt-x', modelAnswered: 'gpt-x' })
    expect(unknown.unpriced).toBe(1)
    expect(unknown.cost).toBe(0)
    const none = await costOf({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, stopReason: null })
    expect(none.unpriced).toBe(0)
    expect(none.noResponse).toBe(1)
  })

  test('priceKey reads through date suffixes, provider prefixes and context tags', () => {
    expect(priceKey('claude-opus-5-5-20261101', prices.models)).toBe('claude-opus-5-5')
    expect(priceKey('anthropic.claude-sonnet-5-5', prices.models)).toBe('claude-sonnet-5-5')
    expect(priceKey('claude-opus-5-5[1m]', prices.models)).toBe('claude-opus-5-5')
    expect(priceKey('claude-opus-4-1-20250805', prices.models)).toBe('claude-opus-4-1')
    expect(priceKey('claude-opus-4', prices.models)).toBe('claude-opus-4')
    expect(priceKey('gpt-x', prices.models)).toBeNull()
  })
})

describe('summary', () => {
  const seeded = async () => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), [
      line(),
      line({ machine: 'server', sessionId: 's2', sessionTitle: 'Trace view work', agentId: 'a1', agentType: 'Explore' }),
      line({ model: 'claude-haiku-5-5', modelAnswered: 'claude-haiku-5-5', effort: 'low', endedAt: new Date(T0 - 3 * 864e5).toISOString() }),
      line({ stopReason: null, error: 'overloaded', cwd: '/work/100%_done' }),
    ].join(''))
    await ingest(db, d, 'mac', prices.models)
    return db
  }

  test('filters combine, and each dropdown counts with every filter but its own', async () => {
    const db = await seeded()
    const s = summary(db, q({ filters: { machine: 'mac', model: 'claude-opus-5-5' } }))
    expect(s.kpis.requests).toBe(2)
    const machines = Object.fromEntries(s.facets.machine.map(f => [f.value, f.n]))
    expect(machines).toEqual({ mac: 2, 'server': 1 })
    expect(s.facets.agent.find(f => f.value === 'main')?.n).toBe(2)
    expect(summary(db, q({ filters: { agent: 'Explore' } })).kpis.requests).toBe(1)
    expect(summary(db, q({ filters: { stop: 'error' } })).kpis.requests).toBe(1)
  })

  test('search matches title, folder and agent text, with LIKE wildcards taken literally', async () => {
    const db = await seeded()
    expect(summary(db, q({ q: 'trace view' })).kpis.requests).toBe(1)
    expect(summary(db, q({ q: '100%_done' })).kpis.requests).toBe(1)
    expect(summary(db, q({ q: '%' })).kpis.requests).toBe(1)
  })

  test('the chart buckets by the viewer\'s day, hourly for two days or less, and keeps model colours unfiltered', async () => {
    const db = await seeded()
    const daily = summary(db, q({ filters: { model: 'claude-haiku-5-5' } }))
    expect(daily.hourly).toBe(false)
    expect(daily.modelOrder).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
    expect(daily.chart.map(c => c.model)).toEqual(['claude-haiku-5-5'])
    const hourly = summary(db, q({ since: T0 - 36e5, until: T0 + 36e5 }))
    expect(hourly.hourly).toBe(true)
    // 10:00 UTC is 15:30 in India: the same request falls in the viewer's 15:00 hour.
    const ist = summary(db, q({ since: T0 - 36e5, until: T0 + 36e5, tzOffsetMin: 330 }))
    expect(new Date(ist.chart[0]!.b * 36e5).getUTCHours()).toBe(15)
  })

  test('tables carry totals, cost and duration percentiles per group', async () => {
    const db = await seeded()
    const s = summary(db, q())
    const opusHigh = s.tables.modelEffort.rows.find(g => g.k === 'claude-opus-5-5\u0000high')!
    expect(opusHigh.requests).toBe(3)
    expect(opusHigh.p50).toBe(1000)
    expect(s.tables.agent.rows.map(g => g.k).sort()).toEqual(['Explore', 'main'])
    expect(s.tables.recent.rows).toHaveLength(4)
    expect(s.tables.recent.total).toBe(4)
    // Every table starts at 10 rows a page until the reader picks a size.
    for (const name of TABLES) expect(s.tables[name].size).toBe(10)
    expect(table(db, q(), 'recent').size).toBe(10)
  })

  test('cost splits by token type, and the parts add up to the total', async () => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), [
      line({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }),
      line({ model: 'claude-haiku-5-5', modelAnswered: 'claude-haiku-5-5', inputTokens: 2_000_000, outputTokens: 0 }),
    ].join(''))
    await ingest(db, d, 'mac', prices.models)
    const s = summary(db, q())
    expect(s.costTypes).toHaveLength(1)
    const t = s.costTypes[0]!
    const opus = prices.models['claude-opus-5-5']!
    expect(t.output).toBeCloseTo(opus[4])
    expect(t.cacheRead).toBeCloseTo(opus[3])
    expect(t.cacheWrite).toBeCloseTo(opus[2]) // the 1-hour write rate by default
    expect(t.input + t.cacheWrite + t.cacheRead + t.output).toBeCloseTo(s.kpis.cost)
    expect(summary(db, q({ ttl: '5m' })).costTypes[0]!.cacheWrite).toBeCloseTo(opus[1])
  })

  test('the hour and weekday grid reads in the viewer\'s clock', async () => {
    const db = await seeded()
    // 2026-11-12 10:00 UTC is a Thursday; 15:30 in India.
    const utc = summary(db, q()).heat
    expect(utc.find(h => h.dow === 4 && h.hour === 10)?.requests).toBe(3)
    const ist = summary(db, q({ tzOffsetMin: 330 })).heat
    expect(ist.find(h => h.dow === 4 && h.hour === 15)?.requests).toBe(3)
    expect(ist.reduce((n, h) => n + h.requests, 0)).toBe(4)
  })

  test('agent share lists every agent with its cost, biggest first', async () => {
    const db = await seeded()
    const a = summary(db, q()).agents
    expect(a.map(x => x.k)).toEqual(['main', 'Explore'])
    expect(a[0]!.requests).toBe(3)
    expect(a.reduce((n, x) => n + x.cost, 0)).toBeCloseTo(summary(db, q()).kpis.cost)
  })

  test('the timeline carries the most recent sessions and each request\'s cache hit rate', async () => {
    const { d, db } = setup()
    const rows = Array.from({ length: 14 }, (_, i) => line({
      sessionId: `s${i}`, sessionTitle: `Session ${i}`, endedAt: new Date(T0 - (14 - i) * 36e5).toISOString(),
      inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0,
    }))
    rows.push(line({ sessionId: 's13', sessionTitle: 'Session 13', agentId: 'a1', agentType: 'Explore', inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }))
    writeFileSync(join(d, '2026-11-12.jsonl'), rows.join(''))
    await ingest(db, d, 'mac', prices.models)
    const t = summary(db, q()).timeline
    expect(t.sessions).toHaveLength(12)
    expect(t.sessions[0]!.id).toBe('s13') // most recent first
    expect(t.sessions.map(s => s.id)).not.toContain('s0')
    expect(t.sessions[0]).toMatchObject({ title: 'Session 13', requests: 2, hit: 0.75 })
    const e = t.events.filter(x => x.s === 's13')
    expect(e).toHaveLength(2)
    expect(e.find(x => !x.sub)!.hit).toBe(0.75)
    expect(e.find(x => x.sub)).toMatchObject({ agent: 'Explore', hit: null }) // nothing sent, so no rate
    expect(summary(db, q({ filters: { session: 'Session 3' } })).timeline.sessions.map(s => s.id)).toEqual(['s3'])
  })

  test('every table pages on the server, with its total and a stable order', async () => {
    const db = await seeded()
    const all = table(db, q(), 'recent', 1, 100).rows.map(r => r.ended_at)
    const p1 = table(db, q(), 'recent', 1, 3)
    const p2 = table(db, q(), 'recent', 2, 3)
    expect([p1.total, p2.total]).toEqual([4, 4])
    expect(p1.rows).toHaveLength(3)
    expect(p2.rows).toHaveLength(1)
    expect([...p1.rows, ...p2.rows].map(r => r.ended_at)).toEqual(all)
    for (const name of ['modelEffort', 'agent', 'machine', 'sessions'] as const) {
      const first = table(db, q(), name, 1, 1)
      expect(first.rows).toHaveLength(1)
      expect(first.total).toBeGreaterThanOrEqual(2)
      expect(table(db, q(), name, 2, 1).rows[0]).not.toEqual(first.rows[0])
    }
    expect(table(db, q({ filters: { machine: 'server' } }), 'sessions', 1, 25).total).toBe(1)
    // A page past the end is empty, not an error.
    expect(table(db, q(), 'recent', 99, 3).rows).toEqual([])
  })

  test('every column sorts both ways on the server, before paging, with nulls last', async () => {
    const db = await seeded()
    for (const name of TABLES) {
      for (const key of SORTS[name]) {
        for (const dir of ['asc', 'desc'] as const) {
          const all = table(db, q(), name, 1, 100, { key, dir }).rows
          const paged = [1, 2, 3, 4].flatMap(n => table(db, q(), name, n, 1, { key, dir }).rows)
          expect(paged).toEqual(all)
        }
      }
    }
    const durations = (dir: 'asc' | 'desc') => table(db, q(), 'recent', 1, 100, { key: 'duration', dir }).rows.map(r => r.duration_ms)
    expect(durations('asc')).toEqual([...durations('asc')].sort((a, b) => (a ?? Infinity) - (b ?? Infinity)))
    const cheapest = table(db, q(), 'modelEffort', 1, 1, { key: 'cost', dir: 'asc' }).rows[0]!
    expect(cheapest.k).toBe('claude-haiku-5-5\u0000low')
    expect(table(db, q(), 'modelEffort', 1, 1, { key: 'cost', dir: 'desc' }).rows[0]!.k).toBe('claude-opus-5-5\u0000high')
    expect(table(db, q(), 'machine', 1, 1, { key: 'k', dir: 'asc' }).rows[0]!.k).toBe('mac')
    expect(table(db, q(), 'sessions', 1, 1, { key: 'requests', dir: 'asc' }).rows[0]!.k).toBe('s2')
    // An unknown column falls back to the default order.
    expect(table(db, q(), 'recent', 1, 100, { key: 'nope', dir: 'asc' }).rows).toEqual(table(db, q(), 'recent', 1, 100).rows)
  })

  test('missing values sort last in both directions', async () => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), [
      line({ durationMs: null }), line({ durationMs: 50 }), line({ durationMs: 900 }),
    ].join(''))
    await ingest(db, d, 'mac', prices.models)
    const by = (dir: 'asc' | 'desc') => table(db, q(), 'recent', 1, 10, { key: 'duration', dir }).rows.map(r => r.duration_ms)
    expect(by('asc')).toEqual([50, 900, null])
    expect(by('desc')).toEqual([900, 50, null])
  })

  test('percentile columns sort across every group, not only the page', async () => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), [
      line({ machine: 'a', durationMs: 50 }), line({ machine: 'b', durationMs: 9000 }), line({ machine: 'c', durationMs: 400 }),
    ].join(''))
    await ingest(db, d, 'mac', prices.models)
    const order = (dir: 'asc' | 'desc') => [1, 2, 3].map(n => table(db, q(), 'machine', n, 1, { key: 'p95', dir }).rows[0]!.k)
    expect(order('asc')).toEqual(['a', 'c', 'b'])
    expect(order('desc')).toEqual(['b', 'c', 'a'])
  })
})

describe('projects, pauses and prompts', () => {
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

  test('each request carries its project, which filters, groups and shares the cost', async () => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), [
      line({ cwd: '/w/shop', sessionId: 'a' }),
      line({ cwd: '/w/shop/.worktrees/fix-cart', sessionId: 'b' }),
      line({ cwd: '/w/blog', sessionId: 'c', model: 'claude-haiku-5-5', modelAnswered: 'claude-haiku-5-5' }),
      line({ cwd: null, sessionId: 'd' }),
    ].join(''))
    await ingest(db, d, 'mac', prices.models)
    const s = summary(db, q())
    expect(Object.fromEntries(s.facets.project.map(f => [f.value, f.n]))).toEqual({ shop: 2, blog: 1, '(none)': 1 })
    expect(s.projects.map(p => p.k)).toEqual(['shop', '(none)', 'blog']) // by cost: two opus requests, one, then haiku
    expect(s.projects.reduce((n, p) => n + p.cost, 0)).toBeCloseTo(s.kpis.cost)
    expect(summary(db, q({ filters: { project: 'shop' } })).kpis.requests).toBe(2)
    expect(table(db, q(), 'project', 1, 10).rows.map(g => g.k)).toContain('blog')
  })

  test('an index from before projects gets them filled in on open', async () => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), line({ cwd: '/w/shop/.claude/worktrees/x' }))
    await ingest(db, d, 'mac', prices.models)
    const raw = new Database(join(d, 'index.sqlite'))
    raw.run('update requests set project = null')
    raw.close()
    const again = open(join(d, 'index.sqlite'), prices)
    expect(summary(again, q()).facets.project.map(f => f.value)).toEqual(['shop'])
  })

  test('a pause past the cache lifetime counts the cache write that follows it, per thread', async () => {
    const { d, db } = setup()
    const req = (min: number, over: Record<string, unknown> = {}) =>
      line({ sessionId: 's', endedAt: at(min), durationMs: 0, inputTokens: 0, cacheWriteTokens: 1_000_000, ...over })
    writeFileSync(join(d, '2026-11-12.jsonl'), [
      req(0), req(10), req(140), // main: gaps of 10 min and 130 min
      req(1, { agentId: 'a1', agentType: 'Explore' }), // a subagent's first request is no pause
      req(141, { agentId: 'a1', agentType: 'Explore' }), // its own thread: 140 min since its last, though main ran a minute ago
      req(150, { cacheWriteTokens: 0 }), // a short gap with nothing written
    ].join(''))
    await ingest(db, d, 'mac', prices.models)
    const hour = summary(db, q({ since: T0 - 864e5, until: T0 + 864e5 })).pauses
    expect(hour.count).toBe(2)
    expect(hour.tokens).toBe(2_000_000)
    expect(hour.cost).toBeCloseTo(2 * prices.models['claude-opus-5-5']![2]) // the 1-hour write rate
    expect(hour.top.map(x => [x.agent, x.gapMs])).toEqual([['Explore', 140 * 60_000], ['main', 130 * 60_000]])
    const five = summary(db, q({ since: T0 - 864e5, until: T0 + 864e5, ttl: '5m' })).pauses
    expect(five.count).toBe(3)
    expect(five.cost).toBeCloseTo(3 * prices.models['claude-opus-5-5']![1])
    // A filter narrows which pauses count, never the gap: the previous request still ends the gap.
    expect(summary(db, q({ since: T0 - 864e5, until: T0 + 864e5, filters: { agent: 'main' } })).pauses.count).toBe(1)
  })

  test('a prompt totals its requests, with each subagent request credited to the prompt running when it started', async () => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), [
      line({ sessionId: 's', turnId: 't1', endedAt: at(0), durationMs: 60_000, inputTokens: 100, cacheReadTokens: 900 }),
      line({ sessionId: 's', turnId: 'x9', agentId: 'a1', agentType: 'Explore', endedAt: at(2), durationMs: 30_000 }),
      line({ sessionId: 's', turnId: 't1', endedAt: at(3), durationMs: 1_000, inputTokens: 100, cacheReadTokens: 4_900 }),
      line({ sessionId: 's', turnId: 't2', endedAt: at(20), durationMs: 1_000, outputTokens: 50 }),
      line({ sessionId: 'z', turnId: null, source: 'model.complete' }), // a plugin's call is no prompt
    ].join(''))
    await ingest(db, d, 'mac', prices.models)
    const p = table(db, q(), 'prompts', 1, 10)
    expect(p.total).toBe(2)
    const t1 = p.rows.find(r => r.k === 't1')!
    expect(t1).toMatchObject({ session: 's', requests: 3, subagents: 1, peak: 5_000 })
    expect(t1.durationMs).toBe(4 * 60_000) // from the first start to the last end
    expect(table(db, q(), 'prompts', 1, 1, { key: 'cost', dir: 'desc' }).rows[0]!.k).toBe('t1')
    expect(table(db, q(), 'prompts', 1, 1, { key: 'started', dir: 'desc' }).rows[0]!.k).toBe('t2')
  })

  test('timeline requests carry their prompt size', async () => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), line({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30 }))
    await ingest(db, d, 'mac', prices.models)
    expect(summary(db, q()).timeline.events[0]!.ctx).toBe(60)
  })
})

describe('right now and the period before', () => {
  const H = 36e5
  const at = (h: number) => new Date(T0 + h * H).toISOString()

  test('the current 5-hour window starts at the first request after the last window ran out', async () => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), [
      line({ endedAt: at(0), durationMs: 0, turnId: 't1' }),
      line({ endedAt: at(1), durationMs: 0, turnId: 't1' }), // same window
      line({ endedAt: at(5.5), durationMs: 0, turnId: 't2', machine: 'server' }), // after it ran out: a new one
      line({ endedAt: at(6), durationMs: 0, turnId: 't3' }),
      line({ endedAt: at(6.1), durationMs: 0, agentId: 'a1', turnId: 'x' }), // a subagent is no prompt of its own
    ].join(''))
    await ingest(db, d, 'mac', prices.models)
    // Filters never narrow it: it covers the whole log.
    const now = summary(db, q({ filters: { machine: 'mac' } }), T0 + 6.2 * H).now
    expect(now.window).toMatchObject({ start: T0 + 5.5 * H, resets: T0 + 10.5 * H, requests: 3, prompts: 2 })
    expect(now.window!.cost).toBeCloseTo(3 * prices.models['claude-opus-5-5']![0])
    expect(summary(db, q(), T0 + 11 * H).now.window).toBeNull() // ran out with nothing since
  })

  test('active sessions are those with a request in the last ten minutes, and the last request is named', async () => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), [
      line({ endedAt: at(0), sessionId: 'old', sessionTitle: 'Old' }),
      line({ endedAt: at(1 - 5 / 60), sessionId: 'a', sessionTitle: 'Cart fix' }),
      line({ endedAt: at(1 - 1 / 60), sessionId: 'b', sessionTitle: null, model: 'claude-haiku-5-5', modelAnswered: 'claude-haiku-5-5' }),
    ].join(''))
    await ingest(db, d, 'mac', prices.models)
    const now = summary(db, q(), T0 + H).now
    expect(now.active.map(x => x.id)).toEqual(['b', 'a'])
    expect(now.last).toMatchObject({ at: T0 + H - 60_000, model: 'claude-haiku-5-5', session: 'b', title: null, machine: 'mac' })
  })

  test('today counts from midnight in the viewer\'s clock', async () => {
    const { d, db } = setup()
    // 2026-11-12 10:00 UTC is 15:30 in India; 2026-11-11 20:00 UTC is 01:30 on the 12th there.
    writeFileSync(join(d, '2026-11-12.jsonl'), [line({ endedAt: at(0) }), line({ endedAt: at(-14) }), line({ endedAt: at(-20) })].join(''))
    await ingest(db, d, 'mac', prices.models)
    expect(summary(db, q({ tzOffsetMin: 0 }), T0 + H).now.today.requests).toBe(1)
    expect(summary(db, q({ tzOffsetMin: 330 }), T0 + H).now.today.requests).toBe(2)
  })

  test('the period before is the same length, just before, under the same filters', async () => {
    const { d, db } = setup()
    writeFileSync(join(d, '2026-11-12.jsonl'), [
      line({ endedAt: at(-1) }), line({ endedAt: at(-2) }), // this period
      line({ endedAt: at(-30), machine: 'server' }), line({ endedAt: at(-40) }), line({ endedAt: at(-47) }), // the one before
      line({ endedAt: at(-60) }), // older still
    ].join(''))
    await ingest(db, d, 'mac', prices.models)
    const s = summary(db, q({ since: T0 - 24 * H, until: T0 }), T0)
    expect(s.kpis.requests).toBe(2)
    expect(s.prev).toMatchObject({ since: T0 - 48 * H, until: T0 - 24 * H, requests: 3 })
    expect(s.prev.cost).toBeCloseTo(3 * prices.models['claude-opus-5-5']![0])
    expect(summary(db, q({ since: T0 - 24 * H, until: T0, filters: { machine: 'mac' } }), T0).prev.requests).toBe(2)
  })
})

describe('peers', () => {
  test('a peer cannot hide or replace a local row by sending the same id', async () => {
    const me = setup()
    writeFileSync(join(me.d, '2026-11-12.jsonl'), line({ sessionId: 'mine' }))
    await ingest(me.db, me.d, 'mac', prices.models)
    const [local] = exportRows(me.db, 0, 10).rows
    const forged = COLUMNS.map(c => (c === 'session_id' ? 'forged' : c === 'ended_at' ? T0 : null))
    insertRows(me.db, 'https://server', [{ uid: local!.uid, cells: forged }], prices.models)
    const ids = summary(me.db, q()).tables.recent.rows.map(r => r.session_id).sort()
    expect(ids).toEqual(['forged', 'mine'])
    // Exports keep the id as this machine wrote it.
    expect(exportRows(me.db, 0, 10).rows[0]!.uid).toBe(local!.uid)
  })

  test('a peer whose position never advances, or that sends too many rows, cannot keep a sync looping', async () => {
    const me = setup()
    const row = { seq: 7, uid: 'x', cells: COLUMNS.map(c => (c === 'ended_at' ? T0 : null)) }
    let calls = 0
    const stuck = (async () => { calls++; return Response.json({ columns: COLUMNS, rows: Array(5000).fill(row) }) }) as unknown as typeof fetch
    await expect(syncPeer(me.db, 'https://stuck', prices.models, stuck)).rejects.toThrow()
    expect(calls).toBeLessThanOrEqual(2)
    const flood = (async () => Response.json({ columns: COLUMNS, rows: Array(5001).fill(row) })) as unknown as typeof fetch
    await expect(syncPeer(me.db, 'https://flood', prices.models, flood)).rejects.toThrow('more rows than asked')
  })

  test('an index from before migrations is rebuilt rather than mixed, and a migrated one is kept', async () => {
    const d = tmp()
    const old = new (await import('bun:sqlite')).Database(join(d, 'index.sqlite'))
    old.run('create table requests (uid text primary key, origin text)')
    old.run("insert into requests values ('mac:x:0', 'local')")
    old.close()
    const db = open(join(d, 'index.sqlite'), prices)
    expect(summary(db, q({ since: 0 })).kpis.requests).toBe(0)
    insertRows(db, 'local', [{ uid: 'a', cells: COLUMNS.map(c => (c === 'ended_at' ? T0 : null)) }], prices.models)
    const again = open(join(d, 'index.sqlite'), prices)
    expect(summary(again, q()).kpis.requests).toBe(1)
  })

  test('a peer exports only its own rows, and a sync copies them once with each cell type-checked', async () => {
    const peer = setup()
    writeFileSync(join(peer.d, '2026-11-12.jsonl'), line({ machine: 'server' }) +
      line({ machine: 'server', sessionId: 's2', durationMs: '<img src=x onerror=alert(1)>' }))
    await ingest(peer.db, peer.d, 'server', prices.models)
    // A row the peer itself copied from someone else is never exported again.
    insertRows(peer.db, 'https://third', [{ uid: 'third:x', cells: COLUMNS.map(() => null) }], prices.models)
    expect(exportRows(peer.db, 0, 10).rows).toHaveLength(2)

    const me = setup()
    const fake = (async (u: string) => {
      const after = Number(new URL(u).searchParams.get('after'))
      return Response.json(exportRows(peer.db, after, 5000))
    }) as unknown as typeof fetch
    expect(await syncPeer(me.db, 'https://server', prices.models, fake)).toBe(2)
    expect(await syncPeer(me.db, 'https://server', prices.models, fake)).toBe(0)
    const s = summary(me.db, q())
    expect(s.kpis.requests).toBe(2)
    expect(s.tables.recent.rows.map(r => r.duration_ms)).toContain(null)
    expect(exportRows(me.db, 0, 10).rows).toHaveLength(0)
  })
})
