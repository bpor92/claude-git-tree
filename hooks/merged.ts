import type { Run } from './worktree'

export type BranchRef = { name: string; tip: string }
export type MergedScan = {
  /** The main line the others are checked against, e.g. refs/remotes/origin/master. */
  base: string
  /** Refs worth drawing: the main line, HEAD's branch and upstream, and every branch not yet in the main line. */
  keep: string[]
  /** How many branches were left out as already merged. */
  hidden: number
}

/** Branches bots open (dependabot, renovate): never part of the graph. */
export const BOT_BRANCHES = ['dependabot', 'renovate']
export const isBotBranch = (name: string) =>
  BOT_BRANCHES.some(bot => new RegExp(`^refs/(heads|remotes/[^/]+)/${bot}/`).test(name))

/** `git for-each-ref` rows: `<refname>\t<sha>\t<symref>`; symbolic refs such as origin/HEAD are skipped. */
export function parseRefs(stdout: string): BranchRef[] {
  return stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter(([name, tip, symref]) => name && tip && !symref)
    .map(([name = '', tip = '']) => ({ name, tip }))
}

/**
 * A branch is merged when its tip is an ancestor of the base (a plain merge), or when
 * its whole change, squashed onto its merge base, matches a commit already in the base
 * (`git cherry` marks it `-`): that is how a squash-merged PR looks.
 */
async function isMerged(run: Run, base: string, tip: string): Promise<boolean> {
  const ancestor = await run(['git', 'merge-base', '--is-ancestor', tip, base])
  if (ancestor.exitCode === 0) return true
  const mb = await run(['git', 'merge-base', base, tip])
  const tree = await run(['git', 'rev-parse', `${tip}^{tree}`])
  if (mb.exitCode !== 0 || tree.exitCode !== 0) return false
  // a throwaway commit object holding the branch's whole change; git gc drops it later
  const squashed = await run(['git', 'commit-tree', tree.stdout.trim(), '-p', mb.stdout.trim(), '-m', 'git-tree: merged check'])
  if (squashed.exitCode !== 0) return false
  const cherry = await run(['git', 'cherry', base, squashed.stdout.trim()])
  return cherry.exitCode === 0 && cherry.stdout.trim().startsWith('-')
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  }
  return out
}

async function baseRef(run: Run, refs: BranchRef[]): Promise<string | null> {
  const origin = await run(['git', 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
  if (origin.exitCode === 0 && origin.stdout.trim()) return origin.stdout.trim()
  for (const name of ['refs/heads/main', 'refs/heads/master']) {
    if (refs.some(r => r.name === name)) return name
  }
  return null
}

/**
 * Splits the repo's branches into the ones to draw and the merged ones to hide.
 * `cache` holds earlier answers by base tip and branch tip, so a poll only checks
 * branches that moved. Bot branches (dependabot, renovate) are always left out.
 */
export async function scanMerged(
  run: Run,
  cache: Map<string, boolean>,
): Promise<MergedScan | null> {
  const list = await run(['git', 'for-each-ref', '--format=%(refname)\t%(objectname)\t%(symref)', 'refs/heads', 'refs/remotes'])
  if (list.exitCode !== 0) return null
  const refs = parseRefs(list.stdout).filter(r => !isBotBranch(r.name))
  const base = await baseRef(run, refs)
  if (!base) return null
  const baseTip = refs.find(r => r.name === base)?.tip ?? ''

  const always = new Set([base, base.replace(/^refs\/remotes\/[^/]+\//, 'refs/heads/')])
  const head = await run(['git', 'symbolic-ref', '-q', 'HEAD'])
  if (head.exitCode === 0) always.add(head.stdout.trim())
  const upstream = await run(['git', 'rev-parse', '--symbolic-full-name', '@{upstream}'])
  if (upstream.exitCode === 0) always.add(upstream.stdout.trim())

  const candidates = refs.filter(r => !always.has(r.name))
  const merged = await inBatches(candidates, 8, async r => {
    const key = `${baseTip}:${r.tip}`
    const known = cache.get(key)
    if (known !== undefined) return known
    const answer = await isMerged(run, base, r.tip)
    cache.set(key, answer)
    return answer
  })

  const keep = [
    ...refs.filter(r => always.has(r.name)).map(r => r.name),
    ...candidates.filter((_, i) => !merged[i]).map(r => r.name),
  ]
  return { base, keep, hidden: merged.filter(Boolean).length }
}
