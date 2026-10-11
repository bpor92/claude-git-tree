import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  ChangedFile,
  CloseState,
  Commit,
  CommitDetail,
  FileDiff,
  OtherWorktree,
  PrRef,
  PrSummary,
  RepoStatus,
  WorktreeInfo,
} from '../types'
import { loadPrs } from './prs'
import { TREE_ICON, renderBand, statusDot } from './band'
import { loadCommit, loadFileDiff } from './commit'
import { ROW_H, SEP, ago, asciiRows, laneWindow, parseLog, refChips, renderLanes } from './graph'
import type { Lanes, RefKind } from './graph'
import { BOT_BRANCHES, scanMerged } from './merged'
import { checkLock, closeWorktree, detectWorktree, dirtyWorktrees, lockMessage } from './worktree'
import type { Run } from './worktree'

const PANE = 'git-tree'
const TITLE = 'Drzewko git'
const POLL_MS = 5000
const MAX_COMMITS = 50

const commits = atom({ plugin: 'git-tree', key: 'commits' } as const, [])
const status = atom({ plugin: 'git-tree', key: 'status' } as const, null)
const error = atom({ plugin: 'git-tree', key: 'error' } as const, null)
const updatedAt = atom({ plugin: 'git-tree', key: 'updatedAt' } as const, 0)
const worktree = atom({ plugin: 'git-tree', key: 'worktree' } as const, null as WorktreeInfo | null)
const close = atom({ plugin: 'git-tree', key: 'close' } as const, { phase: 'idle' } as CloseState)
const hideMerged = atom({ plugin: 'git-tree', key: 'hideMerged' } as const, true)
const hiddenCount = atom({ plugin: 'git-tree', key: 'hiddenCount' } as const, null as number | null)
const selected = atom({ plugin: 'git-tree', key: 'selected' } as const, null as CommitDetail | null)
const openFile = atom({ plugin: 'git-tree', key: 'openFile' } as const, null as FileDiff | null)
const dirtyWts = atom({ plugin: 'git-tree', key: 'dirtyWorktrees' } as const, [] as OtherWorktree[])

const prs = atom({ plugin: 'git-tree', key: 'prs' } as const, null as PrSummary | null)

let lastPrs = ''

/** Pull requests needing you, from GitHub via `gh`; a failed ask keeps what was known. */
async function refreshPrs($: EngineInterface) {
  const summary = await loadPrs(runner($)).catch(() => null)
  if (!summary) return
  const key = JSON.stringify(summary)
  if (key === lastPrs) return
  lastPrs = key
  await update($, prs, () => summary)
}

let lastDirtyWts = ''

/** Checks the repo's other worktrees for uncommitted changes; writes only when that changed. */
async function refreshDirtyWorktrees($: EngineInterface) {
  const list = await dirtyWorktrees(runner($)).catch(() => [])
  const key = JSON.stringify(list)
  if (key === lastDirtyWts) return
  lastDirtyWts = key
  await update($, dirtyWts, () => list)
}

/** "graf-a ●2 · graf-b ●3", or a count once there are more than fit a line. */
export function dirtyWorktreesLabel(list: OtherWorktree[]): string {
  if (list.length > 4) return `${list.length} worktree (${list.reduce((n, w) => n + w.dirty, 0)} plików)`
  return list.map(w => `${w.name} ●${w.dirty}`).join(' · ')
}

const FETCH_MS = 5 * 60_000

// GitHub's mark (octicon mark-github), tinted like the branch name beside it
const GITHUB_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path fill="#5BB450" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'

const runner = ($: EngineInterface): Run => (argv, cwd) =>
  $.process.run(argv, cwd ? { cwd, timeoutMs: 120_000 } : { timeoutMs: 120_000 })

/**
 * "To pull" counts only what the remote-tracking refs know, so bring them up to date now
 * and then: fetch only (no merge, no push), and give up rather than ask for credentials.
 */
async function fetchRemote($: EngineInterface) {
  const r = await $.process.run(['git', 'fetch', '--quiet', '--no-tags'], {
    env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
    timeoutMs: 60_000,
  })
  if (r.exitCode !== 0) return
  await refresh($, true)
}

/** Merged-or-not answers by `<base tip>:<branch tip>`, so a poll only checks branches that moved. */
const mergedCache = new Map<string, boolean>()

export function parseStatus(stdout: string): RepoStatus {
  const [head = '', ...rest] = stdout.split('\n')
  const m = head.match(/^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?/)
  return {
    branch: m?.[1] ?? '?',
    tracking: m?.[2],
    dirty: rest.filter(l => l.trim() !== '').length,
    ahead: Number(head.match(/\bahead (\d+)/)?.[1] ?? 0),
    behind: Number(head.match(/\bbehind (\d+)/)?.[1] ?? 0),
  }
}

/** With `refs`, only those branches are walked; without, every ref but the bots' branches. */
export function logArgv(refs?: string[]): string[] {
  const which = refs
    ? refs
    : [
        // --exclude only applies to the --all that follows it
        ...BOT_BRANCHES.flatMap(bot => [`--exclude=refs/remotes/*/${bot}/*`, `--exclude=refs/heads/${bot}/*`]),
        '--all',
      ]
  return [
    'git', 'log', '--topo-order', '--color=never',
    `--format=%h${SEP}%p${SEP}%D${SEP}%ct${SEP}%an${SEP}%s`,
    ...which,
    '-n', String(MAX_COMMITS),
  ]
}

let lastKey = ''
let lastWorktree = ''
let running = false

async function refreshWorktree($: EngineInterface) {
  // a failed detection hides the button; it never takes the graph down
  const wt = await detectWorktree(runner($)).catch(() => null)
  const key = JSON.stringify(wt)
  if (key === lastWorktree) return
  lastWorktree = key
  await update($, worktree, () => wt)
  // an answer about another (or no) worktree no longer applies; one just finished stays to be read
  const cl = await read($, close)
  if (cl.phase !== 'running' && !(cl.phase === 'done' && cl.ok)) await update($, close, () => ({ phase: 'idle' }) as CloseState)
}

/** The first press: a locked worktree is refused right there, before the confirmation. */
async function askClose($: EngineInterface) {
  const wt = await read($, worktree)
  if (!wt) return
  const lock = await checkLock(runner($), wt).catch(() => null)
  if (lock !== null) {
    await update($, close, () => ({ phase: 'done', ok: false, message: lockMessage(wt, lock), steps: [] }) as CloseState)
    return
  }
  await update($, close, () => ({ phase: 'confirm' }) as CloseState)
}

async function runClose($: EngineInterface) {
  const wt = await read($, worktree)
  if (!wt) return
  await update($, close, () => ({ phase: 'running' }) as CloseState)
  try {
    const res = await closeWorktree(runner($), wt)
    await update($, close, () => ({ phase: 'done', ...res }) as CloseState)
    if (res.ok) {
      $.ui.toast(`Worktree ${wt.branch} zamknięte, zmiany staged w ${wt.mainBranch}`)
      lastWorktree = ''
    }
  } catch (err) {
    await update($, close, () => ({ phase: 'done', ok: false, message: String(err), steps: [] }) as CloseState)
  }
}

/** A click opens the commit's file list under its row; a second click on it closes it. */
async function toggleCommit($: EngineInterface, hash: string) {
  const current = await read($, selected)
  await update($, openFile, () => null)
  if (current?.hash === hash) {
    await update($, selected, () => null)
    return
  }
  await update($, selected, () => ({ hash, files: [], isLoading: true }))
  const detail = await loadCommit(runner($), hash).catch(err => ({ hash, files: [], error: String(err) }))
  // a later click may have moved on while this loaded
  if ((await read($, selected))?.hash === hash) await update($, selected, () => detail)
}

export function explainPrompt(hash: string, subject: string): string {
  return (
    `Wyjaśnij commit ${hash}${subject ? ` („${subject}”)` : ''}: przejrzyj go przez \`git show ${hash}\`, ` +
    'opisz po ludzku, co i dlaczego zmienia, i wskaż, czy coś w nim budzi wątpliwości ' +
    '(błędy, brakujące testy, ryzyko przy wdrożeniu).'
  )
}

/**
 * Writes a ready question about the commit into the prompt box as a draft: the person
 * reads it, edits if they like and sends it with Enter. Nothing is submitted for them.
 */
async function explainCommit($: EngineInterface, hash: string, subject: string) {
  const filled = await $.prompt.fill({ text: explainPrompt(hash, subject) }).catch(() => null)
  $.ui.toast(filled?.isFilled ? 'Pytanie o commit jest w polu wpisywania — naciśnij Enter' : 'Nie udało się wpisać pytania do pola')
}

/** A click on a file shows its diff under it; a second click hides it. */
async function toggleFile($: EngineInterface, hash: string, path: string) {
  const current = await read($, openFile)
  if (current?.hash === hash && current.path === path) {
    await update($, openFile, () => null)
    return
  }
  await update($, openFile, () => ({ hash, path, diff: null }))
  const diff = await loadFileDiff(runner($), hash, path).catch(() => '')
  const now = await read($, openFile)
  if (now?.hash === hash && now.path === path) await update($, openFile, () => ({ hash, path, diff }))
}

async function refresh($: EngineInterface, force = false) {
  if (running) return
  running = true
  try {
    // a failed scan falls back to every branch rather than to an empty graph
    const scan = (await read($, hideMerged)) ? await scanMerged(runner($), mergedCache).catch(() => null) : null
    const hidden = scan?.hidden ?? null
    if ((await read($, hiddenCount)) !== hidden) await update($, hiddenCount, () => hidden)
    const [log, st] = await Promise.all([
      $.process.run(logArgv(scan?.keep)),
      $.process.run(['git', 'status', '--porcelain=v1', '-b']),
    ])
    if (log.exitCode !== 0) {
      const msg = log.stderr.trim() || 'git log się nie powiódł'
      if (force || lastKey !== msg) {
        lastKey = msg
        await update($, error, () => msg)
      }
      return
    }
    // other worktrees change without this one's log or status moving, so check them every poll
    await refreshDirtyWorktrees($)
    const key = log.stdout + '\0' + st.stdout
    if (!force && key === lastKey) return
    lastKey = key
    await update($, commits, () => parseLog(log.stdout))
    await update($, status, () => (st.exitCode === 0 ? parseStatus(st.stdout) : null))
    await update($, error, () => null)
    await update($, updatedAt, () => Date.now())
    await refreshWorktree($)
  } catch (err) {
    await update($, error, () => String(err)).catch(() => {})
  } finally {
    running = false
  }
}

let lanesCache: { key: string; lanes: Lanes } | null = null

/**
 * Scrolling the pane asks for a fresh drawing at every step: hand back the very same
 * lanes markup until the commits change, so the surface has nothing new to load.
 */
export function cachedLanes(list: Commit[], updated: number): Lanes {
  const key = `${updated}:${list.length}:${list[0]?.hash ?? ''}`
  if (lanesCache?.key !== key) lanesCache = { key, lanes: renderLanes(list) }
  return lanesCache.lanes
}

function clock(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const CHIP_COLOR: Record<RefKind, string> = { head: 'claude', remote: 'warning', tag: 'merged', local: 'success' }
const FILE_COLOR: Record<string, string> = { A: 'success', M: 'warning', D: 'error', R: 'suggestion', C: 'suggestion' }
const FILE_LABEL: Record<string, string> = { A: 'nowy', M: 'zmieniony', D: 'usunięty', R: 'przeniesiony', C: 'skopiowany', T: 'zmiana typu' }

export function filesSummary(files: ChangedFile[]): string {
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0)
  const deleted = files.reduce((n, f) => n + (f.deleted ?? 0), 0)
  const word = files.length === 1 ? 'plik' : files.length % 10 >= 2 && files.length % 10 <= 4 && (files.length % 100 < 10 || files.length % 100 >= 20) ? 'pliki' : 'plików'
  return `${files.length} ${word} · +${added} −${deleted}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'git-tree',
      description: 'Pokaż drzewko git bieżącego repo w panelu',
    })
    // state outlives reloads; a worktree answer from before this start is stale
    await update($, close, () => ({ phase: 'idle' }) as CloseState)
    void $.ui.open({ id: PANE, title: TITLE })
    void refresh($, true)
    $.clock.every(POLL_MS, () => void refresh($))
    void fetchRemote($).catch(() => {})
    $.clock.every(FETCH_MS, () => void fetchRemote($).catch(() => {}))
    void refreshPrs($)
    $.clock.every(FETCH_MS, () => void refreshPrs($))

    return next(e)
  })

  on('command.run', { command: 'git-tree' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void refresh($, true)

    return { text: 'Panel z drzewkiem git otwarty.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    refresh($).catch(() => {})

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const st = await read($, status)
    if (!st) return next(e)
    // The band is shared: plugins beneath (next-steps' suggestions, say) draw there too.
    // Ask them first and keep what they drew under this row, never in its place; with
    // nothing beneath to answer, the row stands alone.
    const below = await next(e).catch(() => null)
    const wt = await read($, worktree)
    const others = await read($, dirtyWts)
    const pr = await read($, prs)

    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const synced = st.tracking && st.ahead === 0 && st.behind === 0
    const openTree = () => $.ui.open({ id: PANE, title: TITLE })
    const { Link } = elements
    // the pills are an image and pass no click on; the newest PR of each kind is a real link
    const newestBack = pr?.changesRequested[0]
    const newestReview = pr?.toReview[0]
    const prLinks = (
      <Box flexDirection="row" alignItems="center" gap={2} key="band-pr-links">
        {newestBack && <Link key="band-pr-back" href={newestBack.url} label={`↗ #${newestBack.number} do poprawy`} />}
        {newestReview && <Link key="band-pr-review" href={newestReview.url} label={`↗ #${newestReview.number} do review`} />}
      </Box>
    )

    if (Svg) {
      // one image of pills (it never wraps), then the tree's glyph beside the button that
      // opens it: a Button holds text alone and an Svg passes no click on, so the glyph sits
      // next to the button rather than in it
      const band = renderBand({
        branch: st.branch,
        isWorktree: wt !== null,
        hasUpstream: Boolean(st.tracking),
        ahead: st.ahead,
        behind: st.behind,
        dirty: st.dirty,
        others: others.map(o => ({ name: o.name, dirty: o.dirty })),
        prs: pr && { toReview: pr.toReview.length, changesRequested: pr.changesRequested.length },
      })
      const alt = [
        st.branch,
        synced ? 'aktualne' : '',
        st.ahead ? `${st.ahead} do push` : '',
        st.behind ? `${st.behind} do pobrania` : '',
        st.dirty ? `${st.dirty} niezacommitowane` : '',
        others.length ? `zmiany w worktree: ${dirtyWorktreesLabel(others)}` : '',
        pr ? `PR: ${pr.toReview.length} do review, ${pr.changesRequested.length} do poprawy` : '',
      ]
        .filter(Boolean)
        .join(', ')
      return (
        <Box flexDirection="column" key="git-band-stack">
          <Box flexDirection="row" alignItems="center" justifyContent="space-between" key="git-band">
            <Box flexDirection="row" alignItems="center" gap={2} key="band-left">
              <Svg key="band-pills" source={band.source} alt={alt} width={band.width} height={band.height} />
              {prLinks}
            </Box>
            <Box flexDirection="row" alignItems="center" gap={1} key="band-tree-box">
              <Svg key="band-tree-icon" source={TREE_ICON} alt="drzewko commitów" width={18} height={18} />
              <Button key="band-tree" plain label="›" onPress={openTree} />
            </Box>
          </Box>
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" key="git-band-stack">
        <Box flexDirection="row" gap={2} alignItems="center" key="git-band">
          <Box flexDirection="row" gap={1} alignItems="center" key="band-branch">
            {/* green branch = in step with its remote; no separate "synced" word */}
            <Text color={synced ? 'success' : 'text'}>⎇</Text>
            <Text bold color={synced ? 'success' : 'text'}>
              {st.branch}
            </Text>
            {wt && <Text color="claude">⑂ worktree</Text>}
          </Box>
          {!st.tracking && <Text dimColor>brak gałęzi zdalnej</Text>}
          {st.ahead > 0 && (
            <Text bold color="warning">
              ↑{st.ahead} do push
            </Text>
          )}
          {st.behind > 0 && (
            <Text bold color="suggestion">
              ↓{st.behind} do pobrania
            </Text>
          )}
          {st.dirty > 0 && <Text color="warning">● {st.dirty} niezacommitowane</Text>}
          {others.length > 0 && (
            <Text color="warning">
              <Text bold>⑂ niezacommitowane w worktree:</Text> {dirtyWorktreesLabel(others)}
            </Text>
          )}
          {pr && (
            <Text>
              <Text color={pr.toReview.length ? 'suggestion' : 'inactive'}>PR: {pr.toReview.length} do review</Text>
              <Text dimColor> · </Text>
              <Text color={pr.changesRequested.length ? 'error' : 'inactive'}>{pr.changesRequested.length} do poprawy</Text>
            </Text>
          )}
          {prLinks}
          <Button key="band-tree" plain label="🌳 drzewko" onPress={() => $.ui.open({ id: PANE, title: TITLE })} />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code } = elements
    // the terminal's table answers `Svg` with an empty stand-in, so ask the surface, not the table
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const list = await read($, commits)
    const st = await read($, status)
    const err = await read($, error)
    const at = await read($, updatedAt)
    const wt = await read($, worktree)
    const cl = await read($, close)
    const hideM = await read($, hideMerged)
    const hiddenN = await read($, hiddenCount)
    const sel = await read($, selected)
    const file = await read($, openFile)
    const setClose = (v: CloseState) => update($, close, () => v)
    const now = Date.now()
    const pr = await read($, prs)
    const { Link } = elements

    /** Each PR needing you, a link to it on GitHub; nothing when there are none. */
    const prSection = (title: string, color: string, list: PrRef[], key: string) =>
      list.length > 0 && (
        <Box flexDirection="column" key={key} marginTop={1}>
          <Text bold color={color}>
            {title} ({list.length})
          </Text>
          {list.map(p => (
            <Box flexDirection="row" gap={1} key={`${key}-${p.repo}-${p.number}`}>
              <Link href={p.url} label={`#${p.number} ${p.title}`} />
              <Text dimColor>{p.repo}</Text>
            </Box>
          ))}
        </Box>
      )
    const prList = pr && (pr.toReview.length > 0 || pr.changesRequested.length > 0) && (
      <Box flexDirection="column" key="prs">
        {prSection('Do poprawy po review', 'error', pr.changesRequested, 'pr-back')}
        {prSection('Czekają na Twoje review', 'suggestion', pr.toReview, 'pr-review')}
      </Box>
    )

    const worktreeBox = (wt || cl.phase === 'done') && (
      <Box flexDirection="column" key="worktree" marginTop={1}>
        {wt && (
          <Box flexDirection="row" gap={1} key="wt-info">
            <Text color="claude" bold>
              ⑂ worktree {wt.branch}
            </Text>
            <Text dimColor>
              → repo {wt.mainBranch} ({wt.mainPath})
            </Text>
          </Box>
        )}
        {wt && cl.phase === 'idle' && (
          <Box flexDirection="row" key="wt-idle">
            <Button
              key="wt-close"
              variant="primary"
              label="⤵ Zamknij worktree i przenieś zmiany"
              onPress={() => askClose($)}
            />
          </Box>
        )}
        {wt && cl.phase === 'confirm' && (
          <Box flexDirection="column" key="wt-confirm">
            <Text color="warning">
              Niezacommitowane zmiany w worktree zostaną zacommitowane, a cała gałąź {wt.branch} trafi do{' '}
              {wt.mainBranch} jako staged (bez commita). Potem usunę folder {wt.path} i gałąź {wt.branch}. Bez
              push.
            </Text>
            <Box flexDirection="row" gap={2} key="wt-buttons">
              <Button key="wt-yes" variant="primary" label="Tak, zamknij" onPress={() => runClose($)} />
              <Button key="wt-no" variant="secondary" label="Anuluj" onPress={() => setClose({ phase: 'idle' })} />
            </Box>
          </Box>
        )}
        {cl.phase === 'running' && <Text color="warning">Zamykam worktree…</Text>}
        {cl.phase === 'done' && (
          <Box flexDirection="column" key="wt-done">
            <Text color={cl.ok ? 'success' : 'error'}>
              {cl.ok ? '✓ ' : '✗ '}
              {cl.message}
            </Text>
            {cl.steps.map(step => (
              <Text dimColor>· {step}</Text>
            ))}
            {cl.ok && (
              <Text dimColor>Ta sesja działała w usuniętym worktree — dalszą pracę prowadź w {wt?.mainPath ?? 'głównym repo'}.</Text>
            )}
            <Box flexDirection="row" key="wt-ok">
              <Button key="wt-dismiss" variant="secondary" label="OK" onPress={() => setClose({ phase: 'idle' })} />
            </Box>
          </Box>
        )}
      </Box>
    )

    const header = (
      <Box flexDirection="column" key="top" marginBottom={1}>
        <Box flexDirection="row" gap={1} key="header">
          {Svg ? (
            <Box flexDirection="row" gap={1} alignItems="center" key="branch">
              <Svg key="gh-icon" source={GITHUB_ICON} alt="GitHub" width={16} height={16} />
              <Text bold color="success">
                {st?.branch ?? '?'}
              </Text>
            </Box>
          ) : (
            <Text bold color="success">
              {st ? `⎇ ${st.branch}` : '⎇ ?'}
            </Text>
          )}
          {st?.tracking && <Text dimColor>→ {st.tracking}</Text>}
          {st && st.ahead > 0 && <Text color="warning">↑{st.ahead} do push</Text>}
          {st && st.behind > 0 && <Text color="suggestion">↓{st.behind} do pobrania</Text>}
          {st && st.dirty > 0 ? (
            <Text color="warning">● {st.dirty} niezacommitowane</Text>
          ) : (
            st && <Text color="success">✓ czysto</Text>
          )}
          <Text dimColor>· {clock(at)}</Text>
        </Box>
        <Box flexDirection="row" gap={1} key="actions" marginTop={1} alignItems="center">
          <Button
            key="refresh"
            variant="secondary"
            label="↻ Odśwież"
            onPress={() => Promise.all([refresh($, true), refreshPrs($)])}
          />
          <Button
            key="merged"
            variant="secondary"
            label={
              hideM
                ? `🧹 Scalone: ukryte${hiddenN === null ? ' (liczę…)' : ` (${hiddenN})`}`
                : '🧹 Scalone: widoczne'
            }
            onPress={async () => {
              await update($, hideMerged, v => !v)
              await refresh($, true)
            }}
          />
        </Box>
        {prList}
        {worktreeBox}
      </Box>
    )

    if (err) {
      return (
        <Box flexDirection="column">
          {header}
          <Text color="error">{err}</Text>
        </Box>
      )
    }
    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>Wczytuję…</Text>
        </Box>
      )
    }

    /** The changed files of the opened commit, each one a button that unfolds its diff. */
    const detail = (d: CommitDetail) => (
      <Box
        flexDirection="column"
        key={`detail-${d.hash}`}
        marginTop={1}
        marginBottom={1}
        marginLeft={2}
        paddingX={1}
        borderStyle="round"
        borderColor="claude"
      >
        <Box flexDirection="row" alignItems="center" gap={2} key={`detail-head-${d.hash}`}>
          <Text bold color="claude">
            Zmiany w {d.hash}
          </Text>
          <Button
            key={`explain-${d.hash}`}
            variant="primary"
            label="✨ Wyjaśnij z Claude"
            onPress={() => explainCommit($, d.hash, list.find(c => c.hash === d.hash)?.subject ?? '')}
          />
        </Box>
        {d.isLoading && <Text dimColor>Wczytuję zmiany…</Text>}
        {d.error && <Text color="error">{d.error}</Text>}
        {!d.isLoading && !d.error && d.files.length === 0 && <Text dimColor>Ten commit nie zmienia żadnych plików.</Text>}
        {d.files.length > 0 && (
          <Box flexDirection="row" gap={1} key={`summary-${d.hash}`} marginBottom={1}>
            <Text dimColor>{filesSummary(d.files).replace(/ · .*/, '')} ·</Text>
            <Text color="success">+{d.files.reduce((n, f) => n + (f.added ?? 0), 0)}</Text>
            <Text color="error">−{d.files.reduce((n, f) => n + (f.deleted ?? 0), 0)}</Text>
            <Text dimColor>— kliknij plik, by zobaczyć diff</Text>
          </Box>
        )}
        {d.files.map(f => {
          const isOpen = file?.hash === d.hash && file.path === f.path
          return (
            <Box flexDirection="column" key={`file-box-${f.path}`}>
              {/* colours stand outside the Button: desktop draws its content as plain text */}
              <Box flexDirection="row" gap={1} alignItems="center" key={`file-row-${f.path}`}>
                {Svg ? (
                  <Svg
                    key={`dot-${f.path}`}
                    source={statusDot(f.status)}
                    alt={FILE_LABEL[f.status] ?? f.status}
                    width={16}
                    height={16}
                  />
                ) : (
                  <Text bold color={FILE_COLOR[f.status] ?? 'text'}>
                    ● {f.status}
                  </Text>
                )}
                <Button
                  key={`file-${d.hash}-${f.path}`}
                  plain
                  label={`${isOpen ? '▾' : '▸'} ${f.path}${f.from ? ` ← ${f.from}` : ''}`}
                  onPress={() => toggleFile($, d.hash, f.path)}
                />
                {f.added === null ? (
                  <Text dimColor>binarny</Text>
                ) : (
                  <Text>
                    <Text color="success">+{f.added}</Text> <Text color="error">−{f.deleted}</Text>
                  </Text>
                )}
              </Box>
              {isOpen && file.diff === null && <Text dimColor>Wczytuję diff…</Text>}
              {isOpen && file.diff !== null && (
                <Box key={`diff-${f.path}`} marginTop={1} marginBottom={1}>
                  {file.diff ? (
                    <Code source={file.diff} format="diff" path={f.path} wrap="truncate-end" />
                  ) : (
                    <Text dimColor>Brak zmian tekstowych do pokazania.</Text>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )

    /** One commit as one button: hash, branch chips, subject, age. */
    const rowButton = (c: Commit, prefix = '') => {
      const isOpen = sel?.hash === c.hash
      const isHead = c.refs.some(ref => ref.startsWith('HEAD'))
      return (
        <Button key={`c-${c.hash}`} plain onPress={() => toggleCommit($, c.hash)}>
          {prefix ? <Text color="claude">{prefix}</Text> : ''}
          <Text dimColor>{isOpen ? '▾ ' : '▸ '}</Text>
          <Text color="suggestion">{c.hash}</Text>{' '}
          {refChips(c.refs).map(chip => (
            <Text bold color={CHIP_COLOR[chip.kind]}>
              [{chip.label}]{' '}
            </Text>
          ))}
          <Text bold={isHead}>{c.subject}</Text>
          <Text dimColor> · {ago(c.ts, now)}</Text>
        </Button>
      )
    }

    if (e.surface === 'terminal') {
      const lanes = asciiRows(list)
      return (
        <Box flexDirection="column" width={e.props.bodyColumns}>
          {header}
          {list.map((c, i) => (
            <Box flexDirection="column" key={`t-${c.hash}`}>
              {rowButton(c, lanes[i] ?? '')}
              {sel?.hash === c.hash && detail(sel)}
            </Box>
          ))}
        </Box>
      )
    }

    // Desktop reads a Box's numeric height as rows of text, not pixels, so no box is sized
    // here: each commit row is its own slice of the lanes image (ROW_H px, the one size the
    // desktop honours) beside that commit's button. The image sets the row height, the
    // slices stack into one graph, and an opened commit's files simply follow its row.
    const lanes = cachedLanes(list, at)

    return (
      <Box flexDirection="column">
        {header}
        {list.map((c, i) => (
          <Box flexDirection="column" key={`r-${c.hash}`}>
            <Box flexDirection="row" alignItems="center" gap={1} key={`rr-${c.hash}`}>
              {Svg && (
                // an Svg with an empty alt is not drawn on desktop
                <Svg
                  key={`lane-${c.hash}`}
                  source={laneWindow(lanes, i, i + 1).source}
                  alt={`gałąź przy ${c.hash}`}
                  width={lanes.width}
                  height={ROW_H}
                />
              )}
              {/* desktop draws a Button's content as plain text, so the coloured chips stand before it */}
              {refChips(c.refs).map(chip => (
                <Text bold color={CHIP_COLOR[chip.kind]}>
                  {chip.label}
                </Text>
              ))}
              <Button
                key={`c-${c.hash}`}
                plain
                label={`${sel?.hash === c.hash ? '▾' : '▸'} ${c.hash}  ${c.subject} · ${ago(c.ts, now)}`}
                onPress={() => toggleCommit($, c.hash)}
              />
            </Box>
            {sel?.hash === c.hash && detail(sel)}
          </Box>
        ))}
      </Box>
    )
  })
}
