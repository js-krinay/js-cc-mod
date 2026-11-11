// Zod schemas for everything that enters from outside: a log line, a peer's
// export, an API query, the price table and Claude Code's settings. A bad
// field becomes null (or its default) rather than dropping the whole row or
// request: one odd value in a log line still leaves the rest of it counted.
import { z } from 'zod'

const num = z.number().nullable().catch(null) // Zod 4 already refuses NaN and Infinity

// A number pulled into [min, max]; unreadable falls back to `fallback`.
export const clamped = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().catch(fallback).transform(n => Math.max(min, Math.min(max, n)))
const str = z.string().max(10_000).nullable().catch(null)

// One request as the mod logs it. A peer cannot put markup where a count
// goes: every field is held to its type here.
export const LogRow = z.object({
  endedAt: z.union([z.number(), z.string().transform(s => Date.parse(s)).pipe(z.number())]).nullable().catch(null),
  durationMs: num,
  firstChunkMs: num,
  machine: str,
  user: str,
  sessionId: str,
  sessionTitle: str,
  cwd: str,
  branch: str,
  source: str,
  turnId: str,
  step: num,
  agentId: str,
  agentType: str,
  agentDescription: str,
  model: str,
  modelAnswered: str,
  effort: z.union([z.string(), z.number().transform(String)]).nullable().catch(null),
  stopReason: str,
  inputTokens: num,
  outputTokens: num,
  cacheReadTokens: num,
  cacheWriteTokens: num,
  // The mod logs the tool names; the index keeps how many there were.
  tools: z.union([z.array(z.unknown()).transform(a => a.length), z.number()]).nullable().catch(null),
  error: str,
})
export type LogRow = z.infer<typeof LogRow>

export const EXPORT_PAGE = 5000

// A page of a peer's export. More rows than were asked for, or an id that
// is not a string, is refused outright.
export const PeerExport = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.object({ seq: z.number().int().nonnegative(), uid: z.string().min(1).max(1000), cells: z.array(z.unknown()) }))
    .max(EXPORT_PAGE, 'peer sent more rows than asked'),
})

// Rows per table page until the reader picks another size.
export const DEFAULT_PAGE_SIZE = 10

export const FACET_KEYS = ['machine', 'project', 'session', 'agent', 'model', 'effort', 'branch', 'source', 'stop'] as const
const facet = z.string().min(1).max(1000).optional().catch(undefined)

// The query string of /api/summary and /api/table. Out-of-range or
// unreadable values fall back to their defaults.
export const QueryParams = z.object({
  since: z.coerce.number().catch(() => Date.now() - 14 * 864e5),
  until: z.coerce.number().catch(() => Date.now()),
  tz: clamped(-840, 840, 0),
  ttl: z.enum(['1h', '5m']).catch('1h'),
  q: z.string().trim().max(200).optional().catch(undefined).transform(v => v || undefined),
  size: clamped(1, 200, DEFAULT_PAGE_SIZE),
  page: clamped(1, Number.MAX_SAFE_INTEGER, 1),
  // A table's sort column (checked against that table's columns) and direction.
  sort: z.string().max(40).optional().catch(undefined),
  dir: z.enum(['asc', 'desc']).catch('desc'),
  ...Object.fromEntries(FACET_KEYS.map(k => [k, facet])) as Record<(typeof FACET_KEYS)[number], typeof facet>,
})

// The query string of /api/export, which a peer's sync calls.
export const ExportParams = z.object({
  after: clamped(0, Number.MAX_SAFE_INTEGER, 0),
  limit: clamped(1, EXPORT_PAGE, EXPORT_PAGE),
})

const rates = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]) // input, 5m write, 1h write, read, output

export const PricesFile = z.object({
  source: z.string(),
  checked: z.string(),
  basis: z.string(),
  models: z.record(z.string(), rates),
  longPrompt: z.record(z.string(), z.object({ over: z.number().positive(), prices: rates })).optional(),
})
export type Prices = z.infer<typeof PricesFile>

// Claude Code's user settings: only `env` is read, every other key is kept.
export const Settings = z.looseObject({ env: z.record(z.string(), z.unknown()).optional() })
