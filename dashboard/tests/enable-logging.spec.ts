import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enable } from '../scripts/enable-logging'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'rl-')); dirs.push(d); return d }

test('adds the mod after existing plugin folders, keeps every other setting, and backs the file up', () => {
  const d = tmp(), f = join(d, 'settings.json')
  writeFileSync(f, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/a:/b', SOME_TOKEN: 'secret' }, model: 'opus' }))
  expect(enable(f, '/mods/request-log')).toEqual({ changed: true, dirs: ['/a', '/b', '/mods/request-log'] })
  const s = JSON.parse(readFileSync(f, 'utf8'))
  expect(s).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/a:/b:/mods/request-log', SOME_TOKEN: 'secret' }, model: 'opus' })
  expect(readdirSync(d).filter(n => n.includes('.bak-request-log-'))).toHaveLength(1)
})

test('running it again changes nothing', () => {
  const d = tmp(), f = join(d, 'settings.json')
  writeFileSync(f, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/mods/request-log' } }))
  expect(enable(f, '/mods/request-log').changed).toBe(false)
  expect(readdirSync(d)).toEqual(['settings.json'])
})

test('creates the setting when there is no env block or no file', () => {
  const d = tmp()
  writeFileSync(join(d, 'a.json'), '{}')
  enable(join(d, 'a.json'), '/m')
  expect(JSON.parse(readFileSync(join(d, 'a.json'), 'utf8'))).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/m' } })
  enable(join(d, 'b.json'), '/m')
  expect(JSON.parse(readFileSync(join(d, 'b.json'), 'utf8'))).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/m' } })
})

test('refuses a settings file that is not a JSON object rather than overwriting it', () => {
  const d = tmp(), f = join(d, 'settings.json')
  writeFileSync(f, '[1,2]')
  expect(() => enable(f, '/m')).toThrow('not a JSON object')
  expect(readFileSync(f, 'utf8')).toBe('[1,2]')
})

test('replaces an older copy of the same mod instead of loading it twice', () => {
  const d = tmp(), f = join(d, 'settings.json')
  const plugin = (dir: string, name: string) => {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }))
    return dir
  }
  const old = plugin(join(d, 'old-checkout', 'request-log'), 'request-log')
  const other = plugin(join(d, 'other'), 'other-plugin')
  const now = plugin(join(d, 'cc-mod'), 'request-log')
  writeFileSync(f, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: `${other}:${old}` } }))
  expect(enable(f, now)).toEqual({ changed: true, dirs: [other, now] })
  expect(enable(f, now).changed).toBe(false)
})
