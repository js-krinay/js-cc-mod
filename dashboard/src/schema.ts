// The SQLite index's tables. Derived from the mod's JSONL files (and peers'
// exports): safe to delete, it rebuilds on the next start.
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const requests = sqliteTable('requests', {
  // `<origin>|<id as its source wrote it>`: a peer can never collide with a
  // row this machine wrote, nor with another peer's.
  uid: text('uid').primaryKey(),
  origin: text('origin').notNull(),
  priceKey: text('price_key'),
  endedAt: real('ended_at'),
  durationMs: real('duration_ms'),
  firstChunkMs: real('first_chunk_ms'),
  machine: text('machine'),
  user: text('user'),
  sessionId: text('session_id'),
  sessionTitle: text('session_title'),
  cwd: text('cwd'),
  // The project the folder belongs to (see projectOf), worked out on insert.
  project: text('project'),
  branch: text('branch'),
  source: text('source'),
  turnId: text('turn_id'),
  step: real('step'),
  agentId: text('agent_id'),
  agentType: text('agent_type'),
  agentDescription: text('agent_description'),
  model: text('model'),
  modelAnswered: text('model_answered'),
  effort: text('effort'),
  stopReason: text('stop_reason'),
  inputTokens: real('input_tokens'),
  outputTokens: real('output_tokens'),
  cacheReadTokens: real('cache_read_tokens'),
  cacheWriteTokens: real('cache_write_tokens'),
  tools: real('tools'),
  error: text('error'),
}, t => [
  index('requests_ended_at').on(t.endedAt), index('requests_origin').on(t.origin),
  index('requests_session').on(t.sessionId, t.endedAt),
])

// How far each day's JSONL file has been read, in bytes.
export const files = sqliteTable('files', {
  name: text('name').primaryKey(),
  offset: integer('offset').notNull(),
})

// The last row of each peer's export this machine has copied.
export const peers = sqliteTable('peers', {
  url: text('url').primaryKey(),
  cursor: integer('cursor').notNull().default(0),
})

// USD per million tokens, loaded from prices.json on start; cost is computed
// at query time, so new prices never need a re-ingest.
export const prices = sqliteTable('prices', {
  priceKey: text('price_key').primaryKey(),
  input: real('input'), w5: real('w5'), w1: real('w1'), rd: real('rd'), out: real('out'),
  over: real('over'),
  lInput: real('l_input'), lW5: real('l_w5'), lW1: real('l_w1'), lRd: real('l_rd'), lOut: real('l_out'),
})
