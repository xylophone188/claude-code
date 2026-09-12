import { afterEach, expect, mock, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/hooks.js', () => ({
  executeWorktreeCreateHook: async () => {
    throw new Error('unexpected worktree hook')
  },
  executeWorktreeRemoveHook: async () => false,
  hasWorktreeCreateHook: () => false,
}))
const { runWithCwdOverride } = await import('src/utils/cwd.js')
const { clearResolveGitDirCache, resetGitFileWatcher } = await import(
  'src/utils/git/gitFilesystem.js'
)
const { createAgentWorktree, removeAgentWorktree } = await import(
  'src/utils/worktree.js'
)

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
}

afterEach(() => {
  clearResolveGitDirCache()
  resetGitFileWatcher()
})

test('creates an agent worktree when origin only fetches tags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccb-worktree-'))
  const source = join(root, 'source')
  const origin = join(root, 'origin.git')
  const client = join(root, 'client')
  let worktree: Awaited<ReturnType<typeof createAgentWorktree>> | undefined

  try {
    await mkdir(source)
    git(source, ['init', '--initial-branch=main'])
    git(source, ['config', 'user.email', 'test@example.com'])
    git(source, ['config', 'user.name', 'Test User'])
    await writeFile(join(source, 'README.md'), 'test\n')
    git(source, ['add', 'README.md'])
    git(source, ['commit', '-m', 'initial'])
    git(root, ['clone', '--bare', source, origin])

    await mkdir(client)
    git(client, ['init', '--initial-branch=main'])
    git(client, ['remote', 'add', 'origin', origin])
    git(client, ['config', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*'])

    worktree = await runWithCwdOverride(client, () =>
      createAgentWorktree('tag-only-fetch'),
    )

    expect(worktree.worktreeBranch).toBe('worktree-tag-only-fetch')
    expect(worktree.headCommit).toMatch(/^[0-9a-f]{40}$/)
    git(client, ['show-ref', '--verify', 'refs/remotes/origin/main'])
  } finally {
    if (worktree?.worktreePath) {
      await removeAgentWorktree(
        worktree.worktreePath,
        worktree.worktreeBranch,
        worktree.gitRoot,
        worktree.hookBased,
      )
    }
    await rm(root, { recursive: true, force: true })
  }
})
