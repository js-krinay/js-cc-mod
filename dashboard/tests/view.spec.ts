import { expect, test } from 'bun:test'
import { bucketLabel, chartRows, fmt, ms, readHash, seriesColor, TOP_SERIES, usd, windowOf, writeHash } from '../src/lib/view'

test('the view round-trips through the URL hash and ignores junk', () => {
  const v = readHash('#machine=server&model=claude-opus-5-5&days=30&ttl=5m&metric=cost&q=trace&from=2026-11-01')
  expect(v).toMatchObject({ days: 30, ttl: '5m', metric: 'cost', q: 'trace', from: '2026-11-01',
    filters: { machine: 'server', model: 'claude-opus-5-5' } })
  expect(readHash(writeHash(v))).toEqual(v)
  expect(readHash('#days=9999&metric=<script>&ttl=x')).toMatchObject({ days: 90, metric: 'requests', ttl: '1h' })
  expect(writeHash(readHash(''))).toBe('')
})

test('each table\'s sort round-trips through the URL hash, and a bad one is dropped', () => {
  const v = readHash('#machine=server&sort.recent=cost.asc&sort.sessions=requests.desc')
  expect(v.sorts).toEqual({ recent: { key: 'cost', dir: 'asc' }, sessions: { key: 'requests', dir: 'desc' } })
  expect(readHash(writeHash(v))).toEqual(v)
  expect(writeHash(v)).toContain('sort.recent=cost.asc')
  expect(readHash('#sort.recent=cost.sideways&sort.nope=cost.asc&sort.agent=<b>.desc').sorts).toEqual({})
  expect(readHash('').sorts).toEqual({})
})

test('the window starts at local midnight, and explicit dates cover whole local days', () => {
  const now = new Date(2026, 10, 12, 15, 30)
  const w = windowOf(readHash('#days=7'), now)
  expect(new Date(w.since)).toEqual(new Date(2026, 10, 6))
  expect(w.until).toBe(now.getTime())
  const d = windowOf(readHash('#from=2026-11-10&to=2026-11-10'), now)
  expect(new Date(d.since)).toEqual(new Date(2026, 10, 10))
  expect(d.until - d.since).toBe(864e5 - 1)
})

test('chart rows fill every bucket, fold models past the top into Other, and keep colours by overall rank', () => {
  const size = 864e5, b0 = Math.floor(Date.UTC(2026, 10, 10) / size)
  const order = Array.from({ length: 9 }, (_, i) => `m${i}`)
  const rows = order.map((m, i) => ({ b: b0 + (i % 2) * 2, model: m, requests: 1, output: 10, input: 100, cost: 0.5 }))
  const { data, series } = chartRows(rows, 'requests', order, b0 * size, (b0 + 2) * size, 0, size, false)
  expect(data.map(d => d.bucket)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12'])
  expect(data[1]).toEqual({ bucket: '2026-11-11' })
  expect(series).toHaveLength(TOP_SERIES + 1)
  expect(series.at(-1)).toEqual({ key: `s${TOP_SERIES}`, name: 'Other' })
  expect(data[0]![`s${TOP_SERIES}`]).toBe(1) // m8 (even index) lands on day 0
  expect(data[2]![`s${TOP_SERIES}`]).toBe(1) // m7 lands on day 2
  expect(seriesColor('m3', order)).toBe('var(--series-4)')
  expect(seriesColor('m8', order)).toBe('var(--series-other)')
})

test('series reach the chart under safe keys, whatever a model is called', () => {
  const size = 864e5, b0 = Math.floor(Date.UTC(2026, 10, 10) / size)
  const evil = 'x;} body{background:url(//evil)} .a{'
  const { data, series } = chartRows([{ b: b0, model: evil, requests: 2, output: 0, input: 0, cost: 0 }], 'requests', [evil],
    b0 * size, b0 * size, 0, size, false)
  expect(series).toEqual([{ key: 's0', name: evil }])
  expect(Object.keys(data[0]!)).toEqual(['bucket', 's0'])
})

test('hour labels read in the viewer\'s clock', () => {
  // 10:00 UTC shifted by +5:30 is the 15:00 hour in India.
  const shifted = Date.UTC(2026, 10, 12, 10) + 330 * 60_000
  expect(bucketLabel(Math.floor(shifted / 36e5), 36e5, true)).toBe('2026-11-12 15:00')
})

test('formatters never pass a non-number through', () => {
  expect(fmt('<img>')).toBe('—')
  expect(usd('<img>')).toBe('—')
  expect(ms(null)).toBe('—')
  expect(usd(12.345)).toBe('$12.35')
  expect(usd(0.0042)).toBe('$0.0042')
  expect(fmt(23_770_000)).toBe('23.77M')
  expect(ms(1500)).toBe('1.5s')
})

test('query parameters clamp to their range and fall back when unreadable', async () => {
  const { QueryParams, ExportParams } = await import('../src/schemas')
  expect(QueryParams.parse({ size: '9999', tz: '-5000', page: '0', ttl: 'x', machine: '' })).toMatchObject({ size: 200, tz: -840, page: 1, ttl: '1h', machine: undefined })
  expect(QueryParams.parse({ size: 'abc' }).size).toBe(10)
  expect(ExportParams.parse({ after: '-3', limit: '999999' })).toEqual({ after: 0, limit: 5000 })
})
