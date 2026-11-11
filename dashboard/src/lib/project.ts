// The project a request's working folder belongs to: the folder's own name,
// except that a worktree belongs to the project holding it
// (<project>/.worktrees/<name>, <project>/.claude/worktrees/<name>). Claude
// Code usually runs at a project's root, so the folder's name is the project;
// a session started in a subfolder counts under that subfolder's name.
export function projectOf(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  for (let i = parts.length - 2; i >= 1; i--) {
    if (parts[i] === '.worktrees') return parts[i - 1]!
    if (parts[i] === 'worktrees' && parts[i - 1] === '.claude' && i >= 2) return parts[i - 2]!
  }
  return parts[parts.length - 1]!
}
