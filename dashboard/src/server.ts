// Serves the request-log dashboard on 127.0.0.1; `tailscale serve` publishes
// it to the tailnet. Usage:
//   bun src/server.ts [--port 8787] [--log-dir DIR] [--db FILE] [--host NAME ...] [--peer URL ...]
import { serve } from 'bun'
import { mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import index from './index.html'
import { exportRows, ingest, localRows, open, requestDetail, setPrices, summary, syncPeer, table, TABLES, type Query, type Sort, type TableName } from './db'
import { ExportParams, FACET_KEYS, type Prices, PricesFile, QueryParams, RequestParams } from './schemas'

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    'log-dir': { type: 'string' },
    db: { type: 'string' },
    host: { type: 'string', multiple: true, default: [] },
    peer: { type: 'string', multiple: true, default: [] },
    // Source only: this machine serves its rows to the main dashboard
    // (which lists it with --peer) and has no page of its own.
    'source-only': { type: 'boolean', default: false },
  },
})

const config = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? '', '.claude')
const logDir = args['log-dir'] ?? join(config, 'request-log')
const machine = hostname().split('.')[0]!
const pricesPath = join(import.meta.dir, '..', 'prices.json')
let prices: Prices = PricesFile.parse(await Bun.file(pricesPath).json())
// A machine that has never logged a request has no log folder yet.
const dbPath = args.db ?? join(logDir, 'index.sqlite')
mkdirSync(dirname(dbPath), { recursive: true })
const db = open(dbPath, prices)
const port = Number(args.port)

// Loopback alone is not a boundary: a web page can rebind its own domain to
// 127.0.0.1, so a data request must also name a host we expect.
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...args.host.map(h => h.toLowerCase())])

const status = new Map<string, { name: string; ok: boolean; rows?: number; error?: string; syncedAt?: number }>()

let ingesting: Promise<unknown> | null = null
function refresh() {
  ingesting ??= ingest(db, logDir, machine, prices.models).finally(() => (ingesting = null))
  return ingesting
}
async function syncPeers() {
  for (const url of args.peer) {
    const name = new URL(url).hostname.split('.')[0]!
    try {
      await syncPeer(db, url, prices.models)
      status.set(url, { name, ok: true, syncedAt: Date.now() })
    } catch (e) {
      status.set(url, { ...status.get(url), name, ok: false, error: (e as Error).name })
    }
  }
}
// A price table edited on disk is picked up without a restart.
async function reloadPrices() {
  // A malformed edit is refused (the old prices stay) rather than half-applied.
  const next = PricesFile.parse(await Bun.file(pricesPath).json())
  if (JSON.stringify(next) !== JSON.stringify(prices)) { prices = next; setPrices(db, prices) }
}
await refresh()
setInterval(refresh, 10_000)
void syncPeers()
setInterval(syncPeers, 60_000)
setInterval(() => void reloadPrices().catch(() => {}), 300_000)

function json(req: Request, body: unknown, status = 200) {
  const text = JSON.stringify(body)
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' }
  if ((req.headers.get('accept-encoding') ?? '').includes('gzip') && text.length > 1024) {
    headers['content-encoding'] = 'gzip'
    return new Response(Bun.gzipSync(text), { status, headers })
  }
  return new Response(text, { status, headers })
}

const guarded = (handler: (req: Request, url: URL) => Response | Promise<Response>) => (req: Request) => {
  if (!hosts.has((req.headers.get('host') ?? '').toLowerCase())) return new Response('unexpected host', { status: 403 })
  return handler(req, new URL(req.url))
}

// The filters and window a page asks for, shared by the summary and each table.
function parseQuery(p: URLSearchParams): Query & { page: number; sort?: Sort } {
  const v = QueryParams.parse(Object.fromEntries(p))
  return {
    since: v.since, until: v.until, tzOffsetMin: v.tz, ttl: v.ttl, q: v.q, pageSize: v.size, page: v.page,
    sort: v.sort ? { key: v.sort, dir: v.dir } : undefined,
    filters: Object.fromEntries(FACET_KEYS.flatMap(k => (v[k] ? [[k, v[k]]] : []))),
  }
}

const notFound = () => new Response('not found', { status: 404 })
const server = serve({
  hostname: '127.0.0.1',
  port,
  routes: {
    '/': args['source-only'] ? notFound : index,
    '/api/summary': args['source-only'] ? notFound : guarded(async (req, url) => {
      await refresh()
      return json(req, {
        ...summary(db, parseQuery(url.searchParams)),
        sources: [{ name: machine, ok: true, rows: localRows(db) }, ...[...status.values()]],
        prices: { checked: prices.checked, basis: prices.basis },
        generatedAt: Date.now(),
      })
    }),
    // One page of one table, so paging does not recompute the rest.
    '/api/table': args['source-only'] ? notFound : guarded((req, url) => {
      const name = url.searchParams.get('name') as TableName
      if (!TABLES.includes(name)) return json(req, { error: 'unknown table' }, 400)
      const q = parseQuery(url.searchParams)
      return json(req, table(db, q, name, q.page, q.pageSize, q.sort))
    }),
    // One request in full, for the detail drawer.
    '/api/request': args['source-only'] ? notFound : guarded((req, url) => {
      const v = RequestParams.safeParse(Object.fromEntries(url.searchParams))
      if (!v.success) return json(req, { error: 'uid is required' }, 400)
      const detail = requestDetail(db, v.data.uid, v.data.ttl)
      return detail ? json(req, detail) : json(req, { error: 'no such request' }, 404)
    }),
    '/api/export': guarded(async (req, url) => {
      await refresh()
      const { after, limit } = ExportParams.parse(Object.fromEntries(url.searchParams))
      return json(req, { machine, ...exportRows(db, after, limit) })
    }),
  },
  fetch: notFound,
  development: process.env.NODE_ENV !== 'production' && { hmr: true, console: true },
})

console.error(`request-log dashboard on ${server.url} (${logDir}; peers: ${args.peer.join(', ') || 'none'}${args['source-only'] ? '; source only' : ''})`)
