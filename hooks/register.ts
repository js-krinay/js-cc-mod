import type { EngineInterface, ModelUsage, OpEventResult, Register } from 'claude-code'

type Row = Record<string, unknown>

// One line is one write(2) under O_APPEND, so the lines of the machine's
// sessions never interleave. A shell's printf cannot promise that: macOS's
// /bin/sh (bash 3.2) writes a long line 1 KB at a time. Perl ships with macOS
// and is essential on Ubuntu.
const APPEND = `mkdir -p "$(dirname "$1")" && exec perl -e 'open(my $f, ">>", $ARGV[0]) or exit 1; my $l = "$ARGV[1]\\n"; syswrite($f, $l) == length($l) or exit 1' "$1" "$2"`
// The session's name: its /rename title, else the generated one. The engine
// appends both to the transcript every turn, so the tail holds the latest.
const TITLE = `f=$(ls "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl 2>/dev/null | head -1)
[ -n "$f" ] || exit 0
for k in customTitle aiTitle; do
  t=$(tail -c 1048576 "$f" | grep -a -o "\\"$k\\":\\"[^\\"]*\\"" | tail -1)
  [ -n "$t" ] && break
done
printf '%s' "$t" | sed 's/^"[a-zA-Z]*":"//; s/"$//'`

const tokens = (usage: ModelUsage | null | undefined) => ({
  inputTokens: usage?.input_tokens ?? null,
  outputTokens: usage?.output_tokens ?? null,
  cacheReadTokens: usage?.cache_read_input_tokens ?? null,
  cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
})

// A plugin's `$.model` call as a row: the API reports no answering model for
// these, so `model` is the one asked for (null when the caller named none).
export const modelCall = (
  source: 'model.complete' | 'model.classify' | 'model.fork',
  model: string | null,
  result: OpEventResult<'model.complete'> | OpEventResult<'model.classify'> | OpEventResult<'model.fork'>,
): Row => {
  const value = 'deny' in result ? undefined : result.value
  const answered = typeof value === 'object' && value !== null && 'isAnswered' in value ? value : undefined
  return {
    source,
    model,
    ...tokens(answered?.isAnswered ? answered.usage : null),
    error:
      'deny' in result
        ? `denied: ${result.deny}`
        : answered && !answered.isAnswered
          ? [answered.reason, 'status' in answered ? answered.status : null].filter(v => v != null).join(' ')
          : null,
  }
}

// Read once per module load; the title and branch again on each main turn.
let machine: Promise<string | null> | undefined
let session: Row = {}
let turn: string | undefined
const agents = new Map<string, Row>()

async function run($: EngineInterface, argv: string[]) {
  const r = await $.process.run(argv, { timeoutMs: 5_000 }).catch(() => null)
  return r?.exitCode === 0 ? r.stdout.trim() || null : null
}

async function refresh($: EngineInterface) {
  machine ??= run($, ['hostname', '-s'])
  const id = await $.session.id()
  // USER is often unset on Linux outside a login shell; LOGNAME rarely is.
  const [title, branch, user, logname, version] = await Promise.all([
    run($, ['/bin/sh', '-c', TITLE, 'sh', id]),
    run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD']),
    $.env.get('USER'),
    $.env.get('LOGNAME'),
    $.session.version().catch(() => null),
  ])
  session = {
    machine: await machine,
    user: user || logname || null,
    sessionId: id,
    sessionTitle: title,
    branch,
    engineVersion: version?.version ?? null,
  }
}

async function agent($: EngineInterface, id: string | undefined) {
  if (id === undefined) return { agentId: null, agentType: null, agentDescription: null }
  if (!agents.has(id)) {
    const found = (await $.agent.list().catch(() => [])).find(a => a.id === id)
    agents.set(id, { agentId: id, agentType: found?.type ?? null, agentDescription: found?.description ?? null })
  }
  return agents.get(id)!
}

// A log that cannot be written is dropped: it never fails the request.
async function write($: EngineInterface, row: Row, startedAt: number, endedAt: number) {
  const home = await $.env.get('HOME')
  if (home === undefined) return
  const line = JSON.stringify({
    endedAt: new Date(endedAt).toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: endedAt - startedAt,
    ...session,
    cwd: await $.session.cwd().catch(() => null),
    ...row,
  })
  const file = `${home}/.claude/request-log/${new Date(endedAt).toISOString().slice(0, 10)}.jsonl`
  await run($, ['/bin/sh', '-c', APPEND, 'sh', file, line])
}

// The clock, or null when it cannot be read.
async function now($: EngineInterface) {
  return $.clock.now().catch(() => null)
}

// Logs another plugin's model call; nothing here may fail that call.
export async function logCall($: EngineInterface, row: () => Row, startedAt: number | null) {
  try {
    const endedAt = (await now($)) ?? Date.now()
    await write($, row(), startedAt ?? endedAt, endedAt)
  } catch {}
}

export const register: Register = on => {
  // Every request of the main loop and of each subagent passes through here.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.turnId !== turn) {
      turn = e.turnId
      await refresh($).catch(() => {})
    }
    const startedAt = await $.clock.now()
    let firstChunkAt: number | null = null
    const stream = next(e)
    try {
      for (;;) {
        const chunk = await stream.next()
        if (chunk.done) {
          const r = chunk.value
          const endedAt = await $.clock.now()
          await write(
            $,
            {
              source: 'turn.step',
              turnId: e.turnId,
              step: e.index,
              ...(await agent($, e.agentId)),
              model: e.model,
              modelAnswered: r.usage?.model ?? null,
              effort: e.effort === undefined ? null : String(e.effort),
              messageCount: e.messageCount,
              stopReason: r.stopReason,
              firstChunkMs: firstChunkAt === null ? null : firstChunkAt - startedAt,
              ...tokens(r.usage),
              tools: r.toolUses.map(t => t.name),
              serverTools: (r.serverToolUses ?? []).map(t => t.name),
              error: null,
            },
            startedAt,
            endedAt,
          ).catch(() => {})
          return r
        }
        firstChunkAt ??= await $.clock.now()
        yield chunk.value
      }
    } catch (error) {
      await write(
        $,
        {
          source: 'turn.step',
          turnId: e.turnId,
          step: e.index,
          ...(await agent($, e.agentId).catch(() => ({}))),
          model: e.model,
          effort: e.effort === undefined ? null : String(e.effort),
          error: error instanceof Error ? error.message : String(error),
        },
        startedAt,
        await $.clock.now(),
      ).catch(() => {})
      throw error
    }
  })

  // Other plugins' model calls (a handoff summary, a spoken reply). Logging
  // sits around the call and nothing in it may fail the call: the clock and
  // the row are guarded along with the write.
  on('model.complete', async ($, e, next) => {
    const startedAt = await now($)
    const r = await next(e)
    await logCall($, () => modelCall('model.complete', e.model, r), startedAt)
    return r
  })
  on('model.classify', async ($, e, next) => {
    const startedAt = await now($)
    const r = await next(e)
    await logCall($, () => modelCall('model.classify', e.options?.model ?? null, r), startedAt)
    return r
  })
  on('model.fork', async ($, e, next) => {
    const startedAt = await now($)
    const r = await next(e)
    await logCall($, () => modelCall('model.fork', null, r), startedAt)
    return r
  })
}
