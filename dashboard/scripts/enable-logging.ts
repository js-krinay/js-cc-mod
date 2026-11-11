// Adds the request-log mod to CLAUDE_CODE_PLUGIN_DIRS in Claude Code's user
// settings, so every new session on this machine logs its model requests. An
// older copy of the same mod (another checkout) is replaced, not kept: two
// copies would log every request twice.
// Backs the file up first and prints only the resulting plugin folders, never
// the rest of the settings (their env block can hold secrets).
//   bun scripts/enable-logging.ts [settings.json]
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Settings } from '../src/schemas'

// A plugin folder's name, from its manifest; null when it has none.
function pluginName(dir: string): string | null {
  try { return (JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { name?: unknown }).name as string ?? null } catch { return null }
}

export function enable(settingsPath: string, modDir: string) {
  const parsed = Settings.safeParse(existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {})
  if (!parsed.success) throw new Error('settings is not a JSON object')
  const settings = parsed.data
  settings.env ??= {}
  const name = pluginName(modDir)
  const listed = String(settings.env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(':').filter(Boolean)
  const dirs = listed.filter(d => d === modDir || name == null || pluginName(d) !== name)
  if (dirs.includes(modDir) && dirs.length === listed.length) return { changed: false, dirs }
  const next = dirs.includes(modDir) ? dirs : [...dirs, modDir]
  settings.env.CLAUDE_CODE_PLUGIN_DIRS = next.join(':')
  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak-request-log-${Date.now()}`)
  const tmp = `${settingsPath}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, settingsPath)
  return { changed: true, dirs: next }
}

if (import.meta.main) {
  const config = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? '', '.claude')
  const settingsPath = resolve(process.argv[2] ?? join(config, 'settings.json'))
  const modDir = resolve(import.meta.dir, '..', '..')
  const { changed, dirs } = enable(settingsPath, modDir)
  console.log(changed ? `request-log enabled; new sessions load: ${dirs.join(', ')}` : `request-log already enabled (${modDir})`)
}
