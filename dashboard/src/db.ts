// The request log's SQLite index, through Drizzle. The mod's JSONL files stay
// the record: this index is derived from them (and from peers' exports) and
// can be deleted and rebuilt at any time.
import { Database } from 'bun:sqlite'
import { and, asc, count, desc, eq, gt, gte, inArray, lte, type SQL, sql } from 'drizzle-orm'
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from './schema'
import { DEFAULT_PAGE_SIZE, EXPORT_PAGE, LogRow, PeerExport, type Prices } from './schemas'
import { files, peers, prices as priceTable, requests } from './schema'

export type Db = BunSQLiteDatabase<typeof schema>

export type { Prices }

// What travels between machines, one cell per column, in this order.
export const COLUMNS = [
  'ended_at', 'duration_ms', 'first_chunk_ms', 'machine', 'user', 'session_id', 'session_title', 'cwd', 'branch',
  'source', 'turn_id', 'step', 'agent_id', 'agent_type', 'agent_description', 'model', 'model_answered', 'effort',
  'stop_reason', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'tools', 'error',
] as const
type Column = (typeof COLUMNS)[number]

// Each column's field in the schema, which is also its key in a JSONL line.
const FIELD = {
  ended_at: 'endedAt', duration_ms: 'durationMs', first_chunk_ms: 'firstChunkMs', machine: 'machine', user: 'user',
  session_id: 'sessionId', session_title: 'sessionTitle', cwd: 'cwd', branch: 'branch', source: 'source',
  turn_id: 'turnId', step: 'step', agent_id: 'agentId', agent_type: 'agentType', agent_description: 'agentDescription',
  model: 'model', model_answered: 'modelAnswered', effort: 'effort', stop_reason: 'stopReason',
  input_tokens: 'inputTokens', output_tokens: 'outputTokens', cache_read_tokens: 'cacheReadTokens',
  cache_write_tokens: 'cacheWriteTokens', tools: 'tools', error: 'error',
} as const satisfies Record<Column, keyof LogRow & keyof typeof requests.$inferInsert>

// The price-table key for a model id as the API reports it: a date suffix,
// a provider prefix or a context tag ("[1m]") does not change the price.
export function priceKey(model: unknown, models: Record<string, unknown>): string | null {
  const m = String(model ?? '').toLowerCase().replace(/^anthropic\./, '').replace(/\[.*\]$/, '')
    .replace(/@.*$/, '').replace(/-\d{8}$/, '')
  if (m in models) return m
  return Object.keys(models).filter(k => m.startsWith(k + '-')).sort((a, b) => b.length - a.length)[0] ?? null
}

const MIGRATIONS = join(import.meta.dir, '..', 'drizzle')

export function open(path: string, prices: Prices): Db {
  const sqlite = new Database(path, { create: true })
  sqlite.run('pragma journal_mode = wal')
  sqlite.run('pragma synchronous = normal')
  // An index written before migrations existed is rebuilt: it is derived
  // data, and peers re-send from the start.
  const tables = sqlite.query<{ name: string }, []>(`select name from sqlite_master where type = 'table'`).all().map(t => t.name)
  if (!tables.includes('__drizzle_migrations')) for (const t of ['requests', 'files', 'peers', 'prices']) sqlite.run(`drop table if exists ${t}`)
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS })
  setPrices(db, prices)
  return db
}

export function setPrices(db: Db, prices: Prices) {
  db.transaction(tx => {
    tx.delete(priceTable).run()
    const rows = Object.entries(prices.models).map(([k, [input, w5, w1, rd, out]]) => {
      const l = prices.longPrompt?.[k]
      const [lInput, lW5, lW1, lRd, lOut] = l?.prices ?? []
      return { priceKey: k, input, w5, w1, rd, out, over: l?.over ?? null, lInput, lW5, lW1, lRd, lOut }
    })
    if (rows.length) tx.insert(priceTable).values(rows).run()
    // A model added to the table prices the rows already indexed.
    const model = sql<string | null>`coalesce(${requests.modelAnswered}, ${requests.model})`
    for (const { m } of tx.selectDistinct({ m: model }).from(requests).all()) {
      tx.update(requests).set({ priceKey: priceKey(m, prices.models) }).where(sql`${model} is ${m}`).run()
    }
  })
}

// Stored ids carry their source, so a peer can never collide with (and so
// hide) a row this machine wrote, nor with another peer's.
const LOCAL = 'local'
const storedUid = (origin: string, uid: string) => `${origin}|${uid}`

export function insertRows(db: Db, origin: string, rows: { uid: string; cells: unknown[] }[], models: Record<string, unknown>) {
  let added = 0
  db.transaction(tx => {
    for (let i = 0; i < rows.length; i += 500) {
      const values = rows.slice(i, i + 500).map(({ uid, cells }) => {
        // Every field is held to its type by the schema: a bad one is null.
        const row = LogRow.parse(Object.fromEntries(COLUMNS.map((c, j) => [FIELD[c], cells[j]])))
        return { ...row, uid: storedUid(origin, uid), origin, priceKey: priceKey(row.modelAnswered ?? row.model, models) }
      })
      added += tx.insert(requests).values(values).onConflictDoNothing().returning({ uid: requests.uid }).all().length
    }
  })
  return added
}

// Reads what each day's file gained since the last call, up to its last
// whole line, so a line being written is picked up next time.
export async function ingest(db: Db, logDir: string, machine: string, models: Record<string, unknown>) {
  let names: string[]
  try {
    names = readdirSync(logDir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()
  } catch {
    return { added: 0, skipped: 0 }
  }
  let added = 0, skipped = 0
  const decoder = new TextDecoder()
  for (const name of names) {
    const path = join(logDir, name)
    const size = statSync(path).size
    let offset = db.select({ offset: files.offset }).from(files).where(eq(files.name, name)).get()?.offset ?? 0
    if (size < offset) offset = 0 // the file was replaced: uids keep the old lines from doubling
    if (size === offset) continue
    const bytes = new Uint8Array(await Bun.file(path).slice(offset, size).arrayBuffer())
    const end = bytes.lastIndexOf(0x0a)
    if (end < 0) continue
    const rows: { uid: string; cells: unknown[] }[] = []
    let start = 0
    for (let i = 0; i <= end; i++) {
      if (bytes[i] !== 0x0a) continue
      const at = offset + start
      const line = decoder.decode(bytes.subarray(start, i))
      start = i + 1
      if (!line.trim()) continue
      let o: Record<string, unknown>
      try {
        o = JSON.parse(line)
      } catch {
        skipped++
        continue
      }
      if (!o || typeof o !== 'object' || Array.isArray(o)) { skipped++; continue }
      rows.push({ uid: `${machine}:${name}:${at}`, cells: COLUMNS.map(c => o[FIELD[c]]) })
    }
    added += insertRows(db, LOCAL, rows, models)
    db.insert(files).values({ name, offset: offset + end + 1 })
      .onConflictDoUpdate({ target: files.name, set: { offset: offset + end + 1 } }).run()
  }
  return { added, skipped }
}

const r = requests
const p = priceTable

// This machine's own rows after `after`, for a peer to copy; never rows this
// machine copied from elsewhere, so two machines that sync each other do not loop.
export function exportRows(db: Db, after: number, limit: number) {
  const rows = db.select({ seq: sql<number>`rowid`, row: r }).from(r)
    .where(and(eq(r.origin, LOCAL), gt(sql`rowid`, after))).orderBy(sql`rowid`).limit(limit).all()
  return {
    columns: COLUMNS,
    rows: rows.map(({ seq, row }) => ({
      seq, uid: row.uid.slice(LOCAL.length + 1), cells: COLUMNS.map(c => row[FIELD[c]] ?? null),
    })),
  }
}

const PAGE = EXPORT_PAGE
const MAX_PAGES = 200 // a million rows per sync; the next sync carries on from the cursor

export async function syncPeer(db: Db, url: string, models: Record<string, unknown>, fetchImpl = fetch) {
  const base = url.replace(/\/$/, '')
  let cursor = db.select({ cursor: peers.cursor }).from(peers).where(eq(peers.url, url)).get()?.cursor ?? 0
  let added = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(`${base}/api/export?after=${cursor}&limit=${PAGE}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const parsed = PeerExport.safeParse(await res.json())
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'bad export')
    const data = parsed.data
    // Name cells by the peer's column order, so an older or newer peer still merges.
    const at = new Map(data.columns.map((c, i) => [c, i] as const))
    const rows = data.rows.map(x => ({ uid: x.uid, cells: COLUMNS.map(c => (at.has(c) ? x.cells[at.get(c)!] : null)) }))
    added += insertRows(db, url, rows, models)
    if (data.rows.length === 0) break
    const next = Math.max(cursor, ...data.rows.map(x => x.seq))
    // A position that does not move would ask for the same page forever.
    if (next <= cursor) throw new Error('peer cursor did not advance')
    cursor = next
    db.insert(peers).values({ url, cursor }).onConflictDoUpdate({ target: peers.url, set: { cursor } }).run()
    if (data.rows.length < PAGE) break
  }
  return added
}

export const localRows = (db: Db) => db.select({ n: count() }).from(r).where(eq(r.origin, LOCAL)).get()!.n

// ---- the summary the page draws ----

export type Query = {
  since: number
  until: number
  tzOffsetMin: number // the viewer's offset from UTC, so days and hours are theirs
  ttl: '1h' | '5m'
  filters: Partial<Record<Facet, string>>
  q?: string
  pageSize?: number
}

export const FACETS = {
  machine: sql<string>`coalesce(${r.machine}, '(none)')`,
  session: sql<string>`coalesce(${r.sessionTitle}, ${r.sessionId}, '(none)')`,
  agent: sql<string>`case when ${r.agentId} is null then 'main' else coalesce(${r.agentType}, 'subagent') end`,
  model: sql<string>`coalesce(${r.modelAnswered}, ${r.model}, '(none)')`,
  effort: sql<string>`coalesce(${r.effort}, '(none)')`,
  branch: sql<string>`coalesce(${r.branch}, '(none)')`,
  source: sql<string>`coalesce(${r.source}, '(none)')`,
  stop: sql<string>`case when ${r.error} is not null then 'error' else coalesce(${r.stopReason}, 'no response') end`,
} as const
export type Facet = keyof typeof FACETS

const z = (c: SQL | AnySQLiteColumn) => sql`coalesce(${c}, 0)`

// Cost in USD at list price: null for a model with no price, 0 for a
// request that got no response. Over a long-prompt threshold (Haiku 5.5) the
// whole request pays the higher rates; prompt length counts cache reads and
// writes too.
function cost(ttl: Query['ttl']) {
  const long = sql`(${p.over} is not null and ${z(r.inputTokens)} + ${z(r.cacheReadTokens)} + ${z(r.cacheWriteTokens)} > ${p.over})`
  const [w, lw] = ttl === '5m' ? [p.w5, p.lW5] : [p.w1, p.lW1]
  return sql<number | null>`(case
    when ${r.inputTokens} is null and ${r.outputTokens} is null and ${r.cacheReadTokens} is null and ${r.cacheWriteTokens} is null then 0
    when ${p.priceKey} is null then null
    else (${z(r.inputTokens)} * iif(${long}, ${p.lInput}, ${p.input})
        + ${z(r.cacheWriteTokens)} * iif(${long}, ${lw}, ${w})
        + ${z(r.cacheReadTokens)} * iif(${long}, ${p.lRd}, ${p.rd})
        + ${z(r.outputTokens)} * iif(${long}, ${p.lOut}, ${p.out})) / 1e6 end)`
}

// The same list price split by token type, for the cost-by-type chart. Each
// part is null for a model with no price, like the total.
function costParts(ttl: Query['ttl']) {
  const long = sql`(${p.over} is not null and ${z(r.inputTokens)} + ${z(r.cacheReadTokens)} + ${z(r.cacheWriteTokens)} > ${p.over})`
  const [w, lw] = ttl === '5m' ? [p.w5, p.lW5] : [p.w1, p.lW1]
  const part = (tokens: AnySQLiteColumn, rate: AnySQLiteColumn, longRate: AnySQLiteColumn) =>
    num(sql`coalesce(sum(case when ${p.priceKey} is null then null else ${z(tokens)} * iif(${long}, ${longRate}, ${rate}) / 1e6 end), 0)`)
  return {
    input: part(r.inputTokens, p.input, p.lInput), cacheWrite: part(r.cacheWriteTokens, w, lw),
    cacheRead: part(r.cacheReadTokens, p.rd, p.lRd), output: part(r.outputTokens, p.out, p.lOut),
  }
}

function where(q: Query, skip?: Facet): SQL {
  const parts: SQL[] = [gte(r.endedAt, q.since)!, lte(r.endedAt, q.until)!]
  for (const [k, v] of Object.entries(q.filters) as [Facet, string][]) {
    if (v && k !== skip && k in FACETS) parts.push(sql`${FACETS[k]} = ${v}`)
  }
  if (q.q) {
    const like = `%${q.q.toLowerCase().replace(/[\\%_]/g, m => '\\' + m)}%`
    parts.push(sql`lower(coalesce(${r.sessionTitle},'') || ' ' || coalesce(${r.sessionId},'') || ' ' || coalesce(${r.agentDescription},'')
      || ' ' || coalesce(${r.cwd},'') || ' ' || coalesce(${r.branch},'')) like ${like} escape '\\'`)
  }
  return and(...parts)!
}

const num = (s: SQL) => sql<number>`${s}`.mapWith(Number)
// Share of the prompt read from cache; null when nothing was sent.
const hitRate = (read: SQL, sent: SQL) => sql<number | null>`case when (${sent}) > 0 then 1.0 * (${read}) / (${sent}) end`
const totals = (c: SQL) => ({
  requests: num(sql`count(*)`),
  sessions: num(sql`count(distinct ${r.sessionId})`),
  input: num(sql`coalesce(sum(${r.inputTokens}), 0)`),
  cacheRead: num(sql`coalesce(sum(${r.cacheReadTokens}), 0)`),
  cacheWrite: num(sql`coalesce(sum(${r.cacheWriteTokens}), 0)`),
  output: num(sql`coalesce(sum(${r.outputTokens}), 0)`),
  cost: num(sql`coalesce(sum(${c}), 0)`),
  unpriced: num(sql`coalesce(sum(${c} is null), 0)`),
  noResponse: num(sql`coalesce(sum(${r.error} is not null or ${r.stopReason} is null), 0)`),
  last: sql<number | null>`max(${r.endedAt})`,
})

export type Totals = {
  requests: number; sessions: number; input: number; cacheRead: number; cacheWrite: number; output: number
  cost: number; unpriced: number; noResponse: number; last: number | null
}
export type Group = Totals & { k: string; p50: number | null; p95: number | null }
export type SessionRow = Totals & { k: string; title: string | null; machine: string | null; branch: string | null }
export type RecentRow = {
  ended_at: number; duration_ms: number | null; machine: string | null; session_id: string | null
  session_title: string | null; agent_id: string | null; agent_type: string | null; agent_description: string | null
  model: string; effort: string | null; outcome: string; output_tokens: number | null; input_all: number; cost: number | null
}
export type ChartRow = { b: number; model: string; requests: number; output: number; input: number; cost: number }
export type CostTypeRow = { b: number; input: number; cacheWrite: number; cacheRead: number; output: number }
export type HeatCell = { dow: number; hour: number; requests: number; cost: number } // dow 0 = Sunday
export type AgentShare = { k: string; requests: number; cost: number; output: number }
export type TimelineSession = { id: string; title: string | null; machine: string | null; requests: number; cost: number; hit: number | null; last: number }
// One request on the timeline: s session, t end (ms), d duration (ms), sub a subagent's request.
export type TimelineEvent = { s: string; t: number; d: number | null; model: string; sub: boolean; agent: string; cost: number | null; hit: number | null }

export const TIMELINE_SESSIONS = 12
const TIMELINE_EVENTS = 8000
export type Page<T> = { rows: T[]; total: number; page: number; size: number }

function quantile(sorted: number[], q: number) {
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

export const TABLES = ['modelEffort', 'agent', 'machine', 'sessions', 'recent'] as const
export type TableName = (typeof TABLES)[number]
type TableRow = { modelEffort: Group; agent: Group; machine: Group; sessions: SessionRow; recent: RecentRow }
const GROUP_KEY = {
  modelEffort: sql<string>`${FACETS.model} || char(0) || ${FACETS.effort}`,
  agent: FACETS.agent,
  machine: FACETS.machine,
}

// Requests join their prices on this; written out at each query so Drizzle
// can type every result.
const PRICED = eq(p.priceKey, r.priceKey)

// The columns each table sorts by. p50 and p95 are worked out in code, not
// SQL, so a table sorted by them ranks every group before it pages.
const GROUP_SORTS = ['k', 'requests', 'cost', 'input', 'cacheRead', 'cacheWrite', 'output', 'p50', 'p95'] as const
export const SORTS = {
  modelEffort: GROUP_SORTS, agent: GROUP_SORTS, machine: GROUP_SORTS,
  sessions: ['title', 'last', 'requests', 'cost', 'output', 'cacheRead'],
  recent: ['time', 'session', 'agent', 'model', 'effort', 'input', 'output', 'cost', 'duration', 'outcome'],
} as const satisfies Record<TableName, readonly string[]>
export type Sort = { key: string; dir: 'asc' | 'desc' }

function sortExprs(name: TableName, c: SQL, key: SQL): Record<string, SQL> {
  const sum = (col: AnySQLiteColumn) => sql`coalesce(sum(${col}), 0)`
  const sums = { requests: sql`count(*)`, cost: sql`coalesce(sum(${c}), 0)`, output: sum(r.outputTokens), cacheRead: sum(r.cacheReadTokens) }
  if (name === 'recent') return {
    time: sql`${r.endedAt}`, session: sql`coalesce(${r.sessionTitle}, ${r.sessionId})`,
    agent: sql`case when ${r.agentId} is null then 'main' else coalesce(${r.agentType}, 'subagent') || ': ' || coalesce(${r.agentDescription}, '') end`,
    model: sql`${FACETS.model}`, effort: sql`${r.effort}`, outcome: sql`${FACETS.stop}`,
    input: sql`${z(r.inputTokens)} + ${z(r.cacheReadTokens)} + ${z(r.cacheWriteTokens)}`,
    output: sql`${r.outputTokens}`, cost: c, duration: sql`${r.durationMs}`,
  }
  if (name === 'sessions') return { ...sums, title: sql`coalesce(max(${r.sessionTitle}), ${r.sessionId})`, last: sql`max(${r.endedAt})` }
  return { ...sums, k: key, input: sum(r.inputTokens), cacheWrite: sum(r.cacheWriteTokens) }
}

// ORDER BY for a sort: nulls last both ways, then the table's own tiebreak so pages never overlap.
function orderOf(exprs: Record<string, SQL>, sort: Sort | undefined, fallback: Sort, tiebreak: SQL[]): SQL[] {
  const s = sort && sort.key in exprs ? sort : fallback
  const e = exprs[s.key]!
  return [sql`${e} is null`, s.dir === 'asc' ? asc(e) : desc(e), ...tiebreak]
}

// One page of a table, with its total, so the page draws only what it shows.
export function table<N extends TableName>(db: Db, q: Query, name: N, page = 1, size = DEFAULT_PAGE_SIZE, sort?: Sort): Page<TableRow[N]> {
  const w = where(q)
  const c = cost(q.ttl)
  size = Math.max(1, Math.min(200, Math.floor(size) || DEFAULT_PAGE_SIZE))
  page = Math.max(1, Math.floor(page) || 1)
  const offset = (page - 1) * size

  if (name === 'recent') {
    const total = db.select({ n: count() }).from(r).leftJoin(p, PRICED).where(w).get()!.n
    const rows = db.select({
      ended_at: sql<number>`${r.endedAt}`, duration_ms: r.durationMs, machine: r.machine, session_id: r.sessionId,
      session_title: r.sessionTitle, agent_id: r.agentId, agent_type: r.agentType, agent_description: r.agentDescription,
      model: FACETS.model, effort: r.effort, outcome: FACETS.stop, output_tokens: r.outputTokens,
      input_all: num(sql`${z(r.inputTokens)} + ${z(r.cacheReadTokens)} + ${z(r.cacheWriteTokens)}`),
      cost: c,
    }).from(r).leftJoin(p, PRICED).where(w)
      .orderBy(...orderOf(sortExprs(name, c, sql``), sort, { key: 'time', dir: 'desc' }, [desc(r.endedAt), desc(r.uid)]))
      .limit(size).offset(offset).all()
    return { rows: rows as TableRow[N][], total, page, size }
  }
  if (name === 'sessions') {
    const total = db.select({ n: num(sql`count(distinct ${r.sessionId})`) }).from(r).leftJoin(p, PRICED).where(w).get()!.n
    const rows = db.select({
      k: sql<string>`${r.sessionId}`, title: sql<string | null>`max(${r.sessionTitle})`,
      machine: sql<string | null>`max(${r.machine})`, branch: sql<string | null>`max(${r.branch})`, ...totals(c),
    }).from(r).leftJoin(p, PRICED).where(w).groupBy(r.sessionId)
      .orderBy(...orderOf(sortExprs(name, c, sql``), sort, { key: 'requests', dir: 'desc' }, [asc(r.sessionId)]))
      .limit(size).offset(offset).all()
    return { rows: rows as TableRow[N][], total, page, size }
  }
  const key = GROUP_KEY[name as keyof typeof GROUP_KEY]
  const total = db.select({ n: count() }).from(db.select({ k: key }).from(r).leftJoin(p, PRICED).where(w).groupBy(key).as('g')).get()!.n
  const byPercentile = sort?.key === 'p50' || sort?.key === 'p95'
  const listed = db.select({ k: key, ...totals(c) }).from(r).leftJoin(p, PRICED).where(w).groupBy(key)
    .orderBy(...orderOf(sortExprs(name, c, key), sort, { key: 'requests', dir: 'desc' }, [asc(key)]))
  const rows = byPercentile ? listed.all() : listed.limit(size).offset(offset).all()
  // p50/p95 of request duration: for the groups on this page, or for every
  // group when the table is sorted by them.
  const keys = rows.map(g => g.k)
  const durations = keys.length
    ? db.select({ k: key, d: sql<number>`${r.durationMs}` }).from(r).leftJoin(p, PRICED).where(and(w, sql`${r.durationMs} is not null`, inArray(key, keys))!)
      .orderBy(asc(r.durationMs)).all()
    : []
  const by = new Map<string, number[]>()
  for (const { k, d } of durations) (by.get(k) ?? by.set(k, []).get(k)!).push(d)
  let paged = rows.map(g => ({ ...g, p50: quantile(by.get(g.k) ?? [], 0.5), p95: quantile(by.get(g.k) ?? [], 0.95) }))
  if (byPercentile) {
    const k = sort.key as 'p50' | 'p95'
    const sign = sort.dir === 'asc' ? 1 : -1
    paged = paged
      .sort((a, b) => a[k] == null ? (b[k] == null ? 0 : 1) : b[k] == null ? -1 : sign * (a[k] - b[k]) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .slice(offset, offset + size)
  }
  return { rows: paged as TableRow[N][], total, page, size }
}

export function summary(db: Db, q: Query) {
  const w = where(q)
  const c = cost(q.ttl)
  const sorted = (col: AnySQLiteColumn) =>
    db.select({ d: sql<number>`${col}` }).from(r).leftJoin(p, PRICED).where(and(w, sql`${col} is not null`)!).orderBy(asc(col)).all().map(x => x.d)

  const t = db.select(totals(c)).from(r).leftJoin(p, PRICED).where(w).get() as Totals
  const durations = sorted(r.durationMs)
  const firsts = sorted(r.firstChunkMs)
  const kpis = { ...t, p50: quantile(durations, 0.5), p95: quantile(durations, 0.95), firstP50: quantile(firsts, 0.5) }

  // Each dropdown counts with every other filter applied, never its own.
  const facets = Object.fromEntries((Object.keys(FACETS) as Facet[]).map(k => [k,
    db.select({ value: FACETS[k], n: count() }).from(r).leftJoin(p, PRICED).where(where(q, k)).groupBy(FACETS[k]).orderBy(desc(count())).limit(200).all(),
  ])) as Record<Facet, { value: string; n: number }[]>

  // A model keeps its colour by its rank over the whole range, unfiltered,
  // so a filter never repaints the survivors.
  const modelOrder = db.select({ m: FACETS.model }).from(r).leftJoin(p, PRICED).where(where({ ...q, filters: {}, q: undefined }))
    .groupBy(FACETS.model).orderBy(desc(count())).all().map(x => x.m)

  const hourly = q.until - q.since <= 2 * 864e5 + 1000
  const size = hourly ? 36e5 : 864e5
  const bucket = sql<number>`cast((${r.endedAt} + ${q.tzOffsetMin * 60_000}) / ${size} as integer)`
  const chart = db.select({
    b: bucket, model: FACETS.model, requests: count(),
    output: num(sql`coalesce(sum(${r.outputTokens}), 0)`),
    input: num(sql`coalesce(sum(${r.inputTokens}), 0) + coalesce(sum(${r.cacheReadTokens}), 0) + coalesce(sum(${r.cacheWriteTokens}), 0)`),
    cost: num(sql`coalesce(sum(${c}), 0)`),
  }).from(r).leftJoin(p, PRICED).where(w).groupBy(bucket, FACETS.model).orderBy(asc(bucket)).all() as ChartRow[]

  const parts = costParts(q.ttl)
  const costTypes = db.select({ b: bucket, ...parts }).from(r).leftJoin(p, PRICED).where(w).groupBy(bucket).orderBy(asc(bucket)).all() as CostTypeRow[]

  // Weekday and hour in the viewer's clock (strftime reads UTC, so shift first).
  const local = sql`(${r.endedAt} + ${q.tzOffsetMin * 60_000}) / 1000`
  const dow = sql<number>`cast(strftime('%w', ${local}, 'unixepoch') as integer)`
  const hour = sql<number>`cast(strftime('%H', ${local}, 'unixepoch') as integer)`
  const heat = db.select({ dow, hour, requests: count(), cost: num(sql`coalesce(sum(${c}), 0)`) })
    .from(r).leftJoin(p, PRICED).where(w).groupBy(dow, hour).all() as HeatCell[]

  const agents = db.select({ k: FACETS.agent, requests: count(), cost: num(sql`coalesce(sum(${c}), 0)`), output: num(sql`coalesce(sum(${r.outputTokens}), 0)`) })
    .from(r).leftJoin(p, PRICED).where(w).groupBy(FACETS.agent).orderBy(desc(sql`coalesce(sum(${c}), 0)`), desc(count()), asc(FACETS.agent))
    .limit(50).all() as AgentShare[]

  const sent = sql`${z(r.inputTokens)} + ${z(r.cacheReadTokens)} + ${z(r.cacheWriteTokens)}`
  const sessions = db.select({
    id: sql<string>`${r.sessionId}`, title: sql<string | null>`max(${r.sessionTitle})`, machine: sql<string | null>`max(${r.machine})`,
    requests: count(), cost: num(sql`coalesce(sum(${c}), 0)`),
    hit: hitRate(sql`sum(${z(r.cacheReadTokens)})`, sql`sum(${sent})`), last: sql<number>`max(${r.endedAt})`,
  }).from(r).leftJoin(p, PRICED).where(and(w, sql`${r.sessionId} is not null`)!).groupBy(r.sessionId)
    .orderBy(desc(sql`max(${r.endedAt})`), asc(r.sessionId)).limit(TIMELINE_SESSIONS).all() as TimelineSession[]
  const events = sessions.length ? db.select({
    s: sql<string>`${r.sessionId}`, t: sql<number>`${r.endedAt}`, d: r.durationMs, model: FACETS.model,
    sub: sql<boolean>`${r.agentId} is not null`.mapWith(Boolean), agent: FACETS.agent, cost: c, hit: hitRate(z(r.cacheReadTokens), sent),
  }).from(r).leftJoin(p, PRICED).where(and(w, inArray(r.sessionId, sessions.map(x => x.id)))!)
    .orderBy(asc(r.endedAt), asc(r.uid)).limit(TIMELINE_EVENTS).all() as TimelineEvent[] : []

  const pageSize = q.pageSize ?? DEFAULT_PAGE_SIZE
  const tables = Object.fromEntries(TABLES.map(n => [n, table(db, q, n, 1, pageSize)])) as { [N in TableName]: Page<TableRow[N]> }
  return { kpis, facets, modelOrder, hourly, bucketMs: size, chart, costTypes, heat, agents, timeline: { sessions, events }, tables }
}
