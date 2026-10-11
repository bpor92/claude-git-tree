import type { ChangedFile, CommitDetail } from '../types'
import type { Run } from './worktree'

/** Merges compare against their first parent: what the merge brought into the line. */
const SHOW = ['git', 'show', '--diff-merges=first-parent', '--format=', '-M']

/** `--name-status` and `--numstat` list the same files in the same order; zip them. */
export function parseFiles(nameStatus: string, numstat: string): ChangedFile[] {
  const lines = (s: string) => s.split('\n').filter(l => l.trim() !== '')
  const counts = lines(numstat).map(l => l.split('\t'))
  return lines(nameStatus).map((line, i) => {
    const [code = '?', ...paths] = line.split('\t')
    const [add = '-', del = '-'] = counts[i] ?? []
    const isBinary = add === '-'
    return {
      status: code.charAt(0),
      path: paths[paths.length - 1] ?? '',
      from: paths.length > 1 ? paths[0] : undefined,
      added: isBinary ? null : Number(add),
      deleted: isBinary ? null : Number(del),
    }
  })
}

export async function loadCommit(run: Run, hash: string): Promise<CommitDetail> {
  const [names, nums] = await Promise.all([
    run([...SHOW, '--name-status', hash]),
    run([...SHOW, '--numstat', hash]),
  ])
  if (names.exitCode !== 0) return { hash, files: [], error: names.stderr.trim() || 'git show się nie powiódł' }
  return { hash, files: parseFiles(names.stdout, nums.stdout) }
}

const MAX_DIFF = 60_000

export async function loadFileDiff(run: Run, hash: string, path: string): Promise<string> {
  const r = await run([...SHOW, hash, '--', path])
  if (r.exitCode !== 0) return ''
  return r.stdout.length > MAX_DIFF ? `${r.stdout.slice(0, r.stdout.lastIndexOf('\n', MAX_DIFF))}\n` : r.stdout
}
