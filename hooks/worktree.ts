import type { ProcessRunResult } from 'claude-code'

import type { OtherWorktree, WorktreeInfo } from '../types'

/** cwd absent: the session's own directory. */
export type Run = (argv: string[], cwd?: string) => Promise<ProcessRunResult>

export const AUTO_COMMIT_MESSAGE = 'wip: auto-commit przed zamknięciem worktree'

/** Reads `git rev-parse` + `git worktree list` output; null when cwd is the main checkout or no repo. */
export async function detectWorktree(run: Run, cwd?: string): Promise<WorktreeInfo | null> {
  const rp = await run(
    ['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'],
    cwd,
  )
  if (rp.exitCode !== 0) return null
  const [path = '', gitDir = '', commonDir = '', branch = ''] = rp.stdout.trim().split('\n')
  if (!path || gitDir === commonDir) return null

  const list = await run(['git', 'worktree', 'list', '--porcelain'], cwd)
  if (list.exitCode !== 0) return null
  const main = parseMainWorktree(list.stdout)
  if (!main) return null

  return { path, branch, mainPath: main.path, mainBranch: main.branch }
}

/** Every worktree in `git worktree list --porcelain`, the main checkout first; prunable ones (folder gone) left out. */
export function parseWorktreeList(porcelain: string): { path: string; branch: string; isMain: boolean }[] {
  return porcelain
    .split('\n\n')
    .filter(entry => /^worktree /m.test(entry) && !/^prunable/m.test(entry))
    .map((entry, i) => ({
      path: entry.match(/^worktree (.+)$/m)?.[1] ?? '',
      branch: entry.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? (/^detached/m.test(entry) ? 'detached HEAD' : '?'),
      isMain: i === 0,
    }))
}

/**
 * The repo's other worktrees (not the one the session is in) holding uncommitted
 * changes, with how many files each has changed. Read-only: `git status` in each.
 */
export async function dirtyWorktrees(run: Run): Promise<OtherWorktree[]> {
  const [list, top] = await Promise.all([
    run(['git', 'worktree', 'list', '--porcelain']),
    run(['git', 'rev-parse', '--path-format=absolute', '--show-toplevel']),
  ])
  if (list.exitCode !== 0) return []
  const here = top.stdout.trim()
  const others = parseWorktreeList(list.stdout).filter(w => w.path && w.path !== here)
  const checked = await Promise.all(
    others.map(async w => {
      const st = await run(['git', 'status', '--porcelain'], w.path)
      const dirty = st.exitCode === 0 ? st.stdout.split('\n').filter(l => l.trim() !== '').length : 0
      const name = w.isMain ? 'repo główne' : (w.path.split('/').pop() ?? w.path)
      return { name, path: w.path, branch: w.branch, dirty }
    }),
  )
  return checked.filter(w => w.dirty > 0)
}

export function parseMainWorktree(porcelain: string): { path: string; branch: string } | null {
  const first = porcelain.split('\n\n')[0] ?? ''
  const path = first.match(/^worktree (.+)$/m)?.[1]
  if (!path) return null
  const branch = first.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? (first.includes('\ndetached') ? 'detached HEAD' : '?')
  return { path, branch }
}

/**
 * The lock on the worktree at `path` in `git worktree list --porcelain` output:
 * null when unlocked, the reason (empty when none was given) when locked.
 */
export function parseWorktreeLock(porcelain: string, path: string): string | null {
  for (const entry of porcelain.split('\n\n')) {
    if (entry.match(/^worktree (.+)$/m)?.[1] !== path) continue
    const lock = entry.match(/^locked(?: (.*))?$/m)
    return lock ? (lock[1] ?? '') : null
  }
  return null
}

/** Asks git afresh whether the worktree is locked: the reason, or null when it is free. */
export async function checkLock(run: Run, wt: WorktreeInfo): Promise<string | null> {
  const list = await run(['git', 'worktree', 'list', '--porcelain'], wt.mainPath)
  if (list.exitCode !== 0) return null
  return parseWorktreeLock(list.stdout, wt.path)
}

export function lockMessage(wt: WorktreeInfo, reason: string): string {
  return (
    `Worktree jest zablokowane (${reason || 'bez podanego powodu'}), więc go nie zamykam — nic nie zmieniłem. ` +
    `Najpierw zakończ to, co je trzyma (np. sesję Claude działającą w ${wt.path}).`
  )
}

export type CloseResult = { ok: boolean; message: string; steps: string[] }

/**
 * Commits leftovers in the worktree, squashes its branch into the main checkout
 * (staged, not committed), removes the worktree and deletes its branch. Never pushes.
 * Stops at the first failure and says what state it left.
 */
export async function closeWorktree(run: Run, wt: WorktreeInfo): Promise<CloseResult> {
  const steps: string[] = []
  const fail = (what: string, r: ProcessRunResult, after = '') => ({
    ok: false,
    steps,
    message: `${what}: ${(r.stderr || r.stdout).trim() || `kod ${r.exitCode}`}${after}`,
  })

  if (wt.branch === 'HEAD') {
    return { ok: false, steps, message: 'Worktree jest na odłączonym HEAD — nie ma gałęzi do przeniesienia.' }
  }

  // 0. a locked worktree is refused before anything changes; we never unlock it
  const lock = await checkLock(run, wt)
  if (lock !== null) return { ok: false, steps, message: lockMessage(wt, lock) }

  // 1. main checkout must have no tracked changes, or the squash would mix with them
  const mainDirty = await run(['git', 'status', '--porcelain', '--untracked-files=no'], wt.mainPath)
  if (mainDirty.exitCode !== 0) return fail('Nie mogę odczytać stanu głównego repo', mainDirty)
  if (mainDirty.stdout.trim() !== '') {
    return {
      ok: false,
      steps,
      message: `Główne repo (${wt.mainPath}) ma niezacommitowane zmiany. Zacommituj je albo schowaj (git stash) i spróbuj ponownie.`,
    }
  }

  // 2. auto-commit leftovers in the worktree
  const wtDirty = await run(['git', 'status', '--porcelain'], wt.path)
  if (wtDirty.exitCode !== 0) return fail('Nie mogę odczytać stanu worktree', wtDirty)
  if (wtDirty.stdout.trim() !== '') {
    const add = await run(['git', 'add', '-A'], wt.path)
    if (add.exitCode !== 0) return fail('git add w worktree się nie powiódł', add)
    const commit = await run(['git', 'commit', '-m', AUTO_COMMIT_MESSAGE], wt.path)
    if (commit.exitCode !== 0) return fail('Auto-commit w worktree się nie powiódł', commit)
    steps.push('zacommitowano niezacommitowane zmiany w worktree')
  }

  const tip = await run(['git', 'rev-parse', '--short', wt.branch], wt.mainPath)
  const tipHash = tip.stdout.trim()

  // 3. squash into the main checkout, staged only
  const squash = await run(['git', 'merge', '--squash', wt.branch], wt.mainPath)
  if (squash.exitCode !== 0) {
    await run(['git', 'reset', '--merge'], wt.mainPath)
    return fail(
      `Squash ${wt.branch} do ${wt.mainBranch} się nie powiódł (konflikt?) — główne repo przywrócone, worktree nietknięte`,
      squash,
    )
  }
  steps.push(`zmiany z ${wt.branch} są w ${wt.mainBranch} jako staged (bez commita)`)

  // 4. remove the worktree folder
  const remove = await run(['git', 'worktree', 'remove', wt.path], wt.mainPath)
  if (remove.exitCode !== 0) {
    return fail(
      'Zmiany są już w głównym repo, ale worktree nie dało się usunąć',
      remove,
      ` — usuń ręcznie: git worktree remove --force ${wt.path}`,
    )
  }
  steps.push(`usunięto worktree ${wt.path}`)

  // 5. delete its branch (-D: a squash never marks it merged)
  const del = await run(['git', 'branch', '-D', wt.branch], wt.mainPath)
  if (del.exitCode !== 0) {
    return fail('Worktree usunięte, ale gałęzi nie dało się skasować', del)
  }
  steps.push(`usunięto gałąź ${wt.branch}${tipHash ? ` (była na ${tipHash}, odzyskasz: git branch ${wt.branch} ${tipHash})` : ''}`)

  return {
    ok: true,
    steps,
    message: `Gotowe. Zmiany czekają w ${wt.mainPath} jako staged — przejrzyj i zacommituj. Nic nie zostało wypchnięte.`,
  }
}
