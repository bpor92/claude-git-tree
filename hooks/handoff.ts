/**
 * Finding a handoff document a previous session left for this repo. The handoff skill saves
 * it in the OS temp directory under a free-form name; one counts when its name says
 * "handoff", it is Markdown, recent, and it mentions this repo's path or folder name.
 */

export type HandoffFile = { path: string; mtimeMs: number }

type Entry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }

export type HandoffDeps = {
  /** Directories to look in, the OS temp directory first. */
  dirs: string[]
  list: (dir: string) => Promise<Entry[]>
  read: (path: string) => Promise<string>
  /** Strings a document for this repo mentions: its absolute path, its folder name. */
  marks: string[]
  now: number
}

/** A week: an older handoff is history, not a pickup. */
export const HANDOFF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** How many of the newest candidates are opened to check they are about this repo. */
const READ_AT_MOST = 6

const join = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`

export function handoffCandidates(entries: Entry[], now: number): Entry[] {
  return entries
    .filter(e => e.kind === 'file' && /handoff/i.test(e.name) && /\.md$/i.test(e.name) && now - e.mtimeMs <= HANDOFF_MAX_AGE_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** The newest handoff document about this repo, or null. Never throws. */
export async function findHandoffFile(deps: HandoffDeps): Promise<HandoffFile | null> {
  const found: (Entry & { path: string })[] = []
  for (const dir of [...new Set(deps.dirs)]) {
    const entries = await deps.list(dir).catch(() => [] as Entry[])
    found.push(...handoffCandidates(entries, deps.now).map(e => ({ ...e, path: join(dir, e.name) })))
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const f of found.slice(0, READ_AT_MOST)) {
    const text = await deps.read(f.path).catch(() => '')
    if (deps.marks.some(mark => mark && text.includes(mark))) return { path: f.path, mtimeMs: f.mtimeMs }
  }
  return null
}

/** The prompt that picks the work up in the new session. */
export function loadHandoffPrompt(path: string): string {
  return `Przeczytaj dokument przekazania ${path} i kontynuuj pracę od miejsca, w którym skończyła poprzednia sesja.`
}

/**
 * Offer to load it only when it came from an earlier session (written before this one
 * started) and has not been loaded here yet; this session's own handoff is not a pickup.
 */
export function offerLoad(file: HandoffFile | null, sessionStartedAt: number, loadedPath: string | null): boolean {
  return file !== null && sessionStartedAt > 0 && file.mtimeMs < sessionStartedAt && loadedPath !== file.path
}
