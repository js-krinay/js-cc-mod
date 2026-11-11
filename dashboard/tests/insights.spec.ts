import { expect, test } from 'bun:test'
import { costTypeRows, heatGrid, HEAT_LEVELS, sparkPath, timelineLayout, WEEKDAYS } from '../src/lib/insights'

const DAY = 864e5
const T0 = Date.parse('2026-11-12T00:00:00Z')

test('cost by token type fills every bucket in the window and totals each type', () => {
  const b = Math.floor(T0 / DAY)
  const { data, totals, total } = costTypeRows([{ b, input: 1, cacheWrite: 2, cacheRead: 3, output: 4 }], T0 - 2 * DAY, T0 + 1000, 0, DAY, false)
  expect(data.map(r => r.bucket)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12'])
  expect(data[0]).toMatchObject({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })
  expect(data[2]).toMatchObject({ input: 1, cacheWrite: 2, cacheRead: 3, output: 4 })
  expect(totals).toEqual({ input: 1, cacheWrite: 2, cacheRead: 3, output: 4 })
  expect(total).toBe(10)
})

test('the heat grid starts on Monday, has 24 hours, and steps cells by share of the busiest', () => {
  const { rows, max } = heatGrid([
    { dow: 4, hour: 15, requests: 60, cost: 1 },
    { dow: 0, hour: 2, requests: 1, cost: 9 },
  ], 'requests')
  expect(rows.map(r => r.label)).toEqual(WEEKDAYS.map(w => w[1]))
  expect(rows.every(r => r.cells.length === 24)).toBe(true)
  expect(max).toBe(60)
  const thu = rows.find(r => r.dow === 4)!
  expect(thu.cells[15]).toMatchObject({ value: 60, level: HEAT_LEVELS })
  expect(rows.find(r => r.dow === 0)!.cells[2]!.level).toBe(1) // tiny but not nothing
  expect(thu.cells[14]!.level).toBe(0)
  expect(heatGrid([], 'cost').rows[0]!.cells[0]!.level).toBe(0)
  // The metric changes the busiest cell.
  expect(heatGrid([{ dow: 4, hour: 15, requests: 60, cost: 1 }, { dow: 0, hour: 2, requests: 1, cost: 9 }], 'cost').rows.find(r => r.dow === 0)!.cells[2]!.level).toBe(HEAT_LEVELS)
})

test('a timeline mark spans from its start to its end across the shared track', () => {
  const ev = (t: number, d: number | null) => ({ s: 'a', t, d, model: 'm', sub: false, agent: 'main', cost: 0, hit: 0.5 })
  const { start, end, marks } = timelineLayout([ev(1000, 1000), ev(3000, 500), ev(2000, null)])
  expect([start, end]).toEqual([0, 3000])
  expect(marks[0]).toMatchObject({ left: 0, width: (1000 / 3000) * 100 })
  expect(marks[1]!.left + marks[1]!.width).toBeCloseTo(100)
  expect(marks[2]).toMatchObject({ left: (2000 / 3000) * 100, width: 0 }) // no duration: a point
  expect(timelineLayout([]).marks).toEqual([])
})

test('a sparkline breaks where a request has no cache rate', () => {
  const d = sparkPath([{ t: 0, hit: 1 }, { t: 50, hit: null }, { t: 100, hit: 0 }], 200, 40)
  expect(d).toBe('M0.0,0.0M200.0,40.0')
  expect(sparkPath([{ t: 0, hit: 0.5 }, { t: 100, hit: 0.75 }], 200, 40)).toBe('M0.0,20.0L200.0,10.0')
  expect(sparkPath([{ t: 0, hit: null }], 200, 40)).toBe('')
  expect(sparkPath([{ t: 0, hit: 0.5 }, { t: 9, hit: null }], 200, 40)).toBe('M0.0,20.0L200.0,20.0') // one rate draws flat
})
