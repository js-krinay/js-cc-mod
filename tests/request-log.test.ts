import { expect, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { TurnStepInput, TurnStepResult } from 'claude-code'

import { logCall, modelCall } from '../hooks/register'

type On = Parameters<TestBody>[1]

const done = (stdout = '', exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Stands in for the host: the machine's name, the transcript's title, the
// branch, and the appended lines, which the test reads back.
const host = (on: On, options: { appendFails?: boolean } = {}) => {
  const lines: { file: string; row: Record<string, unknown> }[] = []
  on('env.get', (_, e) => ({ value: { HOME: '/home/t', LOGNAME: 'tester' }[e.name] }))
  let now = Date.parse('2026-11-12T10:00:00Z')
  on('clock.now', () => ({ value: (now += 100) }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work/project' }))
  on('process.run', (_, e) => {
    const [cmd, , script, , arg] = e.argv
    if (cmd === 'hostname') return done('laptop\n')
    if (cmd === 'git') return done('main\n')
    if (script?.includes('customTitle')) return done('Weekly notes')
    if (script?.includes('syswrite')) {
      if (options.appendFails) return done('', 1)
      lines.push({ file: arg!, row: JSON.parse(e.argv[5]!) })
      return done()
    }
    return done('', 127)
  })
  return lines
}

const answer = (over: Partial<TurnStepResult> = {}): TurnStepResult => ({
  turnId: 't1',
  index: 0,
  answer: 'hi',
  toolUses: [{ name: 'Bash', input: {} }, { name: 'Read', input: {} }],
  stopReason: 'tool_use',
  usage: {
    model: 'claude-opus-5-5',
    input_tokens: 10,
    output_tokens: 40,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 30,
  },
  ...over,
})

// Neither the kit's Engine type nor EngineInterface declares turn.step,
// though the kit raises it.
type Steps = { turn: { step: (e: TurnStepInput) => AsyncIterable<unknown> } }
const step = async ($: Engine, agentId?: string) => {
  for await (const _ of ($ as unknown as Steps).turn.step({
    turnId: 't1',
    index: 0,
    model: 'claude-opus-5-5',
    effort: 'high',
    messageCount: 7,
    ...(agentId === undefined ? {} : { agentId }),
  })) {
    // drain the stream so the step settles
  }
}

test('a main-thread request is one line with its session, machine, model, effort and tokens', async ($, on) => {
  const lines = host(on)
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'hi', ref: 1 }
    return answer()
  })

  await step($)

  expect(lines).toHaveLength(1)
  const { file, row } = lines[0]!
  expect(file).toMatch(/^\/home\/t\/\.claude\/request-log\/\d{4}-\d{2}-\d{2}\.jsonl$/)
  expect(row).toMatchObject({
    source: 'turn.step',
    machine: 'laptop',
    user: 'tester',
    sessionId: 'sess-1',
    sessionTitle: 'Weekly notes',
    cwd: '/work/project',
    branch: 'main',
    turnId: 't1',
    step: 0,
    agentId: null,
    model: 'claude-opus-5-5',
    modelAnswered: 'claude-opus-5-5',
    effort: 'high',
    messageCount: 7,
    stopReason: 'tool_use',
    inputTokens: 10,
    outputTokens: 40,
    cacheReadTokens: 20,
    cacheWriteTokens: 30,
    tools: ['Bash', 'Read'],
    error: null,
  })
  expect(typeof row['durationMs']).toBe('number')
  expect(typeof row['firstChunkMs']).toBe('number')
  expect(Date.parse(row['startedAt'] as string)).not.toBeNaN()
  expect(Date.parse(row['endedAt'] as string)).not.toBeNaN()
})

test('a subagent request carries its agent id, type and description', async ($, on) => {
  const lines = host(on)
  on('agent.list', () => ({
    value: [{ id: 'a1', type: 'sonnet-worker', description: 'Implement the badge', status: 'running' }],
  }))
  on('turn.step', async function* () {
    return answer({ usage: { ...answer().usage!, model: 'claude-sonnet-5-5' } })
  })

  await step($, 'a1')

  expect(lines[0]!.row).toMatchObject({
    agentId: 'a1',
    agentType: 'sonnet-worker',
    agentDescription: 'Implement the badge',
    modelAnswered: 'claude-sonnet-5-5',
  })
})

test('a request that got no response (failed or interrupted) is still logged, with null tokens', async ($, on) => {
  const lines = host(on)
  on('turn.step', async function* () {
    return answer({ usage: null, stopReason: null, toolUses: [] })
  })

  await step($)

  expect(lines).toHaveLength(1)
  expect(lines[0]!.row).toMatchObject({
    stopReason: null,
    firstChunkMs: null,
    modelAnswered: null,
    inputTokens: null,
    outputTokens: null,
  })
})

// The kit's $ has no model noun, so a plugin's model call is checked through
// the function that turns one into a row.
test('a plugin model call becomes a row with its source, tokens and failure', () => {
  const ok = modelCall('model.complete', 'claude-haiku-5-5', {
    value: {
      isAnswered: true,
      text: 'ok',
      usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })
  expect(ok).toMatchObject({ source: 'model.complete', model: 'claude-haiku-5-5', inputTokens: 5, outputTokens: 2, error: null })

  const failed = modelCall('model.fork', null, {
    value: { isAnswered: false, reason: 'api-error', status: 529, kind: 'overloaded' },
  } as never)
  expect(failed).toMatchObject({ source: 'model.fork', inputTokens: null, error: 'api-error 529' })

  expect(modelCall('model.classify', null, { deny: 'refused' })).toMatchObject({ error: 'denied: refused' })
})

test('a log that cannot be written never fails the request', async ($, on) => {
  host(on, { appendFails: true })
  on('turn.step', async function* () {
    return answer()
  })

  await step($)
})

test('logging another plugin\'s model call cannot fail it, whatever breaks', async () => {
  const noClock = { clock: { now: () => Promise.reject(new Error('no clock')) } } as never
  await expect(logCall(noClock, () => ({ source: 'model.complete' }), null)).resolves.toBeUndefined()
  await expect(logCall(noClock, () => { throw new Error('bad row') }, 1)).resolves.toBeUndefined()
})
