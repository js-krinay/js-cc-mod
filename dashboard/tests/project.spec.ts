import { expect, test } from 'bun:test'
import { projectOf } from '../src/lib/project'

test('a folder is its own project, and a worktree belongs to the project that holds it', () => {
  expect(projectOf('/home/a/Work/shop')).toBe('shop')
  expect(projectOf('/home/a/Work/shop/')).toBe('shop')
  expect(projectOf('/home/a/Work/shop/.worktrees/fix-cart')).toBe('shop')
  expect(projectOf('/home/a/Work/shop/.claude/worktrees/fix-cart')).toBe('shop')
  expect(projectOf('C:\\Users\\a\\shop')).toBe('shop')
  expect(projectOf('/')).toBe('/')
  expect(projectOf(null)).toBeNull()
  expect(projectOf('')).toBeNull()
})
