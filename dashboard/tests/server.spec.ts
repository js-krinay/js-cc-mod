import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'rl-srv-'))
const port = 18787 + Math.floor(Math.random() * 1000)
let proc: ReturnType<typeof Bun.spawn>

beforeAll(async () => {
  writeFileSync(join(dir, '2026-11-12.jsonl'), JSON.stringify({ endedAt: new Date().toISOString(), machine: 'mac',
    sessionId: 's1', model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 10, stopReason: 'end_turn' }) + '\n')
  proc = Bun.spawn(['bun', 'src/server.ts', '--port', String(port), '--log-dir', dir, '--db', join(dir, 'i.sqlite'),
    '--host', 'mac.tail.ts.net:8443'], { cwd: join(import.meta.dir, '..'), env: { ...process.env, NODE_ENV: 'production' }, stderr: 'pipe' })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return } catch {}
    await Bun.sleep(250)
  }
  throw new Error('server did not start')
})
afterAll(() => { proc?.kill(); rmSync(dir, { recursive: true, force: true }) })

const get = (path: string, host?: string) =>
  fetch(`http://127.0.0.1:${port}${path}`, host ? { headers: { host } } : {})

test('serves the page with its title and icon', async () => {
  const html = await (await get('/')).text()
  expect(html).toContain('<title>Request Log</title>')
  expect(html).toMatch(/rel="icon"[^>]*href="[^"]+\.svg"/)
})

test('answers the data API for loopback and the tailnet name it was given', async () => {
  const s = await (await get('/api/summary?since=0')).json()
  expect(s.kpis.requests).toBe(1)
  expect((await get('/api/summary', 'mac.tail.ts.net:8443')).status).toBe(200)
})

test('refuses a data request naming any other host, as a DNS-rebinding page would', async () => {
  expect((await get('/api/summary', 'evil.example:8787')).status).toBe(403)
  expect((await get('/api/export', 'evil.example')).status).toBe(403)
})

test('unknown paths are 404', async () => {
  expect((await get('/server.ts')).status).toBe(404)
  expect((await get('/../prices.json')).status).toBe(404)
})

test('starts on a machine that has never logged a request (no log folder yet)', async () => {
  const missing = join(dir, 'not-yet', 'request-log')
  const p2 = 19787 + Math.floor(Math.random() * 1000)
  const child = Bun.spawn(['bun', 'src/server.ts', '--port', String(p2), '--log-dir', missing],
    { cwd: join(import.meta.dir, '..'), env: { ...process.env, NODE_ENV: 'production' }, stderr: 'pipe' })
  try {
    let status = 0
    for (let i = 0; i < 60 && status !== 200; i++) {
      status = await fetch(`http://127.0.0.1:${p2}/api/summary`).then(r => r.status, () => 0)
      if (status !== 200) await Bun.sleep(250)
    }
    expect(status).toBe(200)
  } finally {
    child.kill()
  }
})

test('a machine set up as a source only serves its rows and nothing else', async () => {
  const p3 = 20787 + Math.floor(Math.random() * 1000)
  const child = Bun.spawn(['bun', 'src/server.ts', '--port', String(p3), '--log-dir', dir, '--db', join(dir, 'src.sqlite'),
    '--source-only'], { cwd: join(import.meta.dir, '..'), env: { ...process.env, NODE_ENV: 'production' }, stderr: 'pipe' })
  try {
    let exp: Response | undefined
    for (let i = 0; i < 60 && !exp?.ok; i++) {
      exp = await fetch(`http://127.0.0.1:${p3}/api/export?after=0`).catch(() => undefined)
      if (!exp?.ok) await Bun.sleep(250)
    }
    expect((await exp!.json()).rows).toHaveLength(1)
    const page = await fetch(`http://127.0.0.1:${p3}/`, { redirect: 'manual' })
    expect(page.status).toBe(404)
    for (const path of ['/api/summary', '/api/table?name=recent']) expect((await fetch(`http://127.0.0.1:${p3}${path}`)).status).toBe(404)
  } finally {
    child.kill()
  }
})

test('a table pages on its own endpoint, under the same host guard', async () => {
  const page = await (await get('/api/table?name=recent&page=1&size=1&since=0')).json()
  expect(page).toMatchObject({ total: 1, page: 1, size: 1 })
  expect(page.rows).toHaveLength(1)
  expect((await (await get('/api/table?name=recent&since=0&sort=duration&dir=asc')).json()).rows).toHaveLength(1)
  // A bad sort or direction is ignored, never an error.
  expect((await get('/api/table?name=recent&since=0&sort=evil;drop&dir=sideways')).status).toBe(200)
  expect((await get('/api/table?name=nope')).status).toBe(400)
  const uid = page.rows[0].uid
  const detail = await get(`/api/request?uid=${encodeURIComponent(uid)}`)
  expect(detail.status).toBe(200)
  expect((await detail.json()).request.uid).toBe(uid)
  expect((await get('/api/request?uid=nope')).status).toBe(404)
  expect((await get('/api/request')).status).toBe(400)
  expect((await get(`/api/request?uid=${encodeURIComponent(uid)}`, 'evil.example')).status).toBe(403)
  expect((await get('/api/table?name=recent', 'evil.example')).status).toBe(403)
})
