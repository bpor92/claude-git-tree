import type { PrRef, PrSummary } from '../types'
import type { Run } from './worktree'

const FIELDS = ['--json', 'number,title,url,repository,author,updatedAt', '--limit', '50', '--sort', 'updated', '--order', 'desc']

type SearchRow = {
  number: number
  title: string
  url: string
  updatedAt: string
  repository: { nameWithOwner: string }
  author: { login: string; type?: string; is_bot?: boolean }
}

/** Most recently active first: the head of the list is "the newest". */
const byNewest = (a: PrRef, b: PrRef) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)

/** GitHub reports dependabot with `is_bot: false`; its type and its `[bot]` login give it away. */
export const isBot = (a: SearchRow['author']) => a.type === 'Bot' || a.is_bot === true || a.login.endsWith('[bot]')

const toRef = (r: SearchRow): PrRef => ({
  repo: r.repository.nameWithOwner,
  number: r.number,
  title: r.title,
  url: r.url,
  updatedAt: r.updatedAt ?? '',
})

export function parseSearch(stdout: string): SearchRow[] {
  try {
    const rows: unknown = JSON.parse(stdout)
    return Array.isArray(rows) ? (rows as SearchRow[]) : []
  } catch {
    return []
  }
}

/** Waiting on you: review requests to you, and open PRs by other people (not bots) in your repos. */
export function toReview(requested: SearchRow[], inMyRepos: SearchRow[], me: string): PrRef[] {
  const seen = new Set<string>()
  const out: PrRef[] = []
  for (const r of [...requested, ...inMyRepos]) {
    if (r.author.login === me || isBot(r.author)) continue
    const key = `${r.repository.nameWithOwner}#${r.number}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(toRef(r))
  }
  // two searches merged: order them again as one list
  return out.sort(byNewest)
}

let login: string | null = null

/**
 * Asks GitHub through `gh` (read-only searches). null when `gh` is missing, logged out or
 * offline, so the band shows nothing rather than a wrong zero.
 */
export async function loadPrs(run: Run): Promise<PrSummary | null> {
  if (!login) {
    const who = await run(['gh', 'api', 'user', '--jq', '.login'])
    if (who.exitCode !== 0 || !who.stdout.trim()) return null
    login = who.stdout.trim()
  }
  const [requested, mine, back] = await Promise.all([
    run(['gh', 'search', 'prs', '--review-requested=@me', '--state=open', ...FIELDS]),
    run(['gh', 'search', 'prs', `--owner=${login}`, '--state=open', ...FIELDS, '--', `-author:${login}`]),
    run(['gh', 'search', 'prs', '--author=@me', '--state=open', '--review=changes_requested', ...FIELDS]),
  ])
  if (requested.exitCode !== 0 || mine.exitCode !== 0 || back.exitCode !== 0) return null
  return {
    toReview: toReview(parseSearch(requested.stdout), parseSearch(mine.stdout), login),
    changesRequested: parseSearch(back.stdout).map(toRef).sort(byNewest),
  }
}
