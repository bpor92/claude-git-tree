import { describe, expect, test } from 'claude-code/testing'

import { boldSans, plural, renderBand, statusDot } from './band'
import { parseFiles } from './commit'
import { HANDOFF_MAX_AGE_MS, findHandoffFile, handoffCandidates, loadHandoffPrompt, offerLoad } from './handoff'
import { isBot, parseSearch, toReview } from './prs'
import { ROW_H, asciiRows, laneWindow, layout, parseLog, renderLanes } from './graph'
import { isBotBranch, parseRefs, scanMerged } from './merged'
import { cachedLanes, dirtyWorktreesLabel, explainPrompt, filesSummary, findHandoff, HANDOFF_PURPOSE, handoffBlocked, logArgv, parseStatus } from './register'
import { dirtyWorktrees, parseWorktreeList, parseWorktreeLock } from './worktree'

const S = '\x1f'
const row = (h: string, p: string, refs: string, subject: string) => [h, p, refs, '1791000000', 'Bartek', subject].join(S)

// m merges b into a; a and b both branch from base
const LOG = [
  row('m000001', 'a000001 b000001', 'HEAD -> master, origin/master, origin/HEAD', 'Merge b'),
  row('b000001', 'base001', 'feat/b', 'feat b'),
  row('a000001', 'base001', '', 'fix a'),
  row('base001', 'root001', 'tag: v1', 'base'),
].join('\n')

const STATUS = '## master...origin/master [ahead 1]\n M backend/app.php\n?? nowy.txt\n'

const PANE_PROPS = { title: 'Drzewko git', isFocused: false, bodyColumns: 80, placement: 'dock' } as never
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

describe('parsing', () => {
  test('log rows become commits, origin/HEAD dropped', async () => {
    const out = parseLog(LOG)
    expect(out).toHaveLength(4)
    expect(out[0]).toMatchObject({
      hash: 'm000001',
      parents: ['a000001', 'b000001'],
      refs: ['HEAD -> master', 'origin/master'],
      subject: 'Merge b',
    })
  })

  test('status reads branch, tracking, dirty count, ahead and behind', async () => {
    expect(parseStatus(STATUS)).toEqual({ branch: 'master', tracking: 'origin/master', dirty: 2, ahead: 1, behind: 0 })
    expect(parseStatus('## feat...origin/feat [ahead 2, behind 5]\n')).toMatchObject({ ahead: 2, behind: 5 })
    expect(parseStatus('## feat\n')).toMatchObject({ tracking: undefined, ahead: 0, behind: 0 })
  })

  test('git log asks for 50 commits; bot branches always excluded, before --all', async () => {
    const argv = logArgv()
    expect(argv.slice(-2)).toEqual(['-n', '50'])
    expect(argv.indexOf('--exclude=refs/remotes/*/dependabot/*')).toBeLessThan(argv.indexOf('--all'))
    expect(argv).toContain('--exclude=refs/remotes/*/renovate/*')
    expect(isBotBranch('refs/remotes/origin/dependabot/npm/x')).toBe(true)
    expect(isBotBranch('refs/heads/renovate/react')).toBe(true)
    expect(isBotBranch('refs/heads/feat/dependabot-config')).toBe(false)
  })

  test('with a ref list, git log walks only those refs', async () => {
    const argv = logArgv(['refs/remotes/origin/master', 'refs/heads/feat'])
    expect(argv).not.toContain('--all')
    expect(argv).toContain('refs/heads/feat')
  })

  test('changed files zip name-status with numstat; renames keep both paths; binaries have no counts', async () => {
    const files = parseFiles(
      'M\tsrc/a.ts\nR087\told/b.ts\tnew/b.ts\nA\tlogo.png\nD\tgone.txt\n',
      '3\t1\tsrc/a.ts\n2\t2\tnew/b.ts\n-\t-\tlogo.png\n0\t9\tgone.txt\n',
    )
    expect(files).toEqual([
      { status: 'M', path: 'src/a.ts', from: undefined, added: 3, deleted: 1 },
      { status: 'R', path: 'new/b.ts', from: 'old/b.ts', added: 2, deleted: 2 },
      { status: 'A', path: 'logo.png', from: undefined, added: null, deleted: null },
      { status: 'D', path: 'gone.txt', from: undefined, added: 0, deleted: 9 },
    ])
    expect(filesSummary(files)).toBe('4 pliki · +5 −12')
    expect(filesSummary(files.slice(0, 1))).toBe('1 plik · +3 −1')
  })
})

describe('layout', () => {
  test('a merge opens a second lane that rejoins at the fork point', async () => {
    const { rows, edges, lanes } = layout(parseLog(LOG))
    expect(lanes).toBe(2)
    expect(rows.map(r => r.lane)).toEqual([0, 1, 0, 0])
    expect(rows[0]?.isMerge).toBe(true)
    expect(edges.find(e => e.fromRow === 1)).toMatchObject({ toRow: 3, viaLane: 1, toLane: 0 })
    expect(edges.find(e => e.fromRow === 3)).toMatchObject({ toRow: null })
  })

  test('ascii lanes for the terminal', async () => {
    expect(asciiRows(parseLog(LOG))).toEqual(['◉   ', '│ ● ', '● │ ', '●   '])
  })

  test('a row slice of the lanes holds only the shapes crossing that row', async () => {
    const lanes = renderLanes(parseLog(LOG))
    expect(lanes.rows).toBe(4)
    const first = laneWindow(lanes, 0, 1)
    expect(first.height).toBe(ROW_H)
    expect(first.source).toContain(`viewBox="0 0 ${lanes.width} ${ROW_H}"`)
    expect(first.source).not.toContain('<text')
    const dots = (s: string) => (s.match(/<circle/g) ?? []).length
    // row 0: the merge dot and HEAD's ring, nothing from rows below
    expect(dots(first.source)).toBe(2)
    // row 2: its own dot only; the lines of b and of the merge pass through it
    const third = laneWindow(lanes, 2, 3).source
    expect(dots(third)).toBe(1)
    expect((third.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  test('scrolling redraws hand back the identical lanes until the commits change', async () => {
    const list = parseLog(LOG)
    const a = cachedLanes(list, 1)
    expect(cachedLanes(list, 1)).toBe(a)
    expect(cachedLanes(list, 2)).not.toBe(a)
  })
})

test('pane draws on every surface', async ($, on) => {
  on('process.run', async (_$, e) => ok(e.argv[1] === 'log' ? LOG : STATUS))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'git-tree', surface, component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Button', key: 'c-m000001' })).toBeDefined()
    expect(await ui.find({ type: 'Select' })).toBeUndefined()
    if (surface === 'desktop') {
      expect(await ui.find({ type: 'Text', text: 'master' })).toBeDefined()
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(5) // GitHub icon + one lanes slice per row
      expect(await ui.find({ type: 'Box', key: 'r-m000001' })).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Text', text: '⎇ master' })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('clicking a commit lists its files under it; clicking a file shows its diff', async ($, on) => {
  const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n'
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.startsWith('git log')) return ok(LOG)
    if (a.includes('--name-status')) return ok('M\tsrc/a.ts\nA\tREADME.md\n')
    if (a.includes('--numstat')) return ok('1\t1\tsrc/a.ts\n4\t0\tREADME.md\n')
    if (a.startsWith('git show') && a.endsWith('-- src/a.ts')) return ok(DIFF)
    return ok(STATUS)
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'git-tree', surface, component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'c-b000001' })
    expect(await ui.find({ type: 'Text', text: /Zmiany w b000001/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 pliki/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '−1' })).toBeDefined()
    if (surface === 'desktop') {
      // icon + 4 lane slices + 2 status dots
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(7)
    }
    expect(await ui.find({ type: 'Button', key: 'file-b000001-src/a.ts' })).toBeDefined()
    await ui.press({ key: 'file-b000001-src/a.ts' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    await ui.press({ key: 'file-b000001-src/a.ts' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.press({ key: 'c-b000001' })
    expect(await ui.find({ type: 'Button', key: 'file-b000001-src/a.ts' })).toBeUndefined()
    await ui.unmount()
  }
})

test('"Wyjaśnij z Claude" drafts a question about the commit into the prompt box, sending nothing', async ($, on) => {
  const filled: string[] = []
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.startsWith('git log')) return ok(LOG)
    if (a.includes('--name-status')) return ok('M\tsrc/a.ts\n')
    if (a.includes('--numstat')) return ok('1\t1\tsrc/a.ts\n')
    return ok(STATUS)
  })
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  const ui = await $.ui.mount({ plugin: 'git-tree', surface: 'desktop', component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'c-a000001' })
  await ui.press({ key: 'explain-a000001' })
  expect(filled).toEqual([explainPrompt('a000001', 'fix a')])
  expect(filled[0]).toContain('git show a000001')
  await ui.press({ key: 'c-a000001' })
  await ui.unmount()
})

test('worktree button: confirm, then squash, remove, delete branch — no push', async ($, on) => {
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    calls.push(a)
    if (a.startsWith('git log')) return ok(LOG)
    if (a.startsWith('git status --porcelain=v1 -b')) return ok(STATUS)
    if (a.startsWith('git rev-parse --path-format=absolute')) return ok('/wt\n/repo/.git/worktrees/wt\n/repo/.git\nfeat/x\n')
    if (a.startsWith('git worktree list')) return ok('worktree /repo\nHEAD abc\nbranch refs/heads/master\n\nworktree /wt\nHEAD def\nbranch refs/heads/feat/x\n')
    if (a.startsWith('git status --porcelain') && (e.init?.cwd === '/wt' || e.init?.cwd === undefined)) return ok('?? new.txt\n')
    if (a.startsWith('git rev-parse --short')) return ok('def1234\n')
    return ok()
  })
  const ui = await $.ui.mount({ plugin: 'git-tree', surface: 'desktop', component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'wt-close' })
  expect(await ui.find({ type: 'Button', key: 'wt-yes' })).toBeDefined()
  expect(calls.some(c => c.startsWith('git merge'))).toBe(false)
  await ui.press({ key: 'wt-yes' })
  expect(calls).toContain('git commit -m wip: auto-commit przed zamknięciem worktree')
  expect(calls).toContain('git merge --squash feat/x')
  expect(calls).toContain('git worktree remove /wt')
  expect(calls).toContain('git branch -D feat/x')
  expect(calls.some(c => c.includes('push'))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Gotowe/ })).toBeDefined()
  await ui.unmount()
})

describe('worktree lock', () => {
  const LIST = 'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\nworktree /wt\nHEAD def\nbranch refs/heads/feat/x\n'
  test('reads the lock reason of the matching worktree only', async () => {
    expect(parseWorktreeLock(LIST, '/wt')).toBeNull()
    expect(parseWorktreeLock(LIST + 'locked claude session x (pid 1)\n', '/wt')).toBe('claude session x (pid 1)')
    expect(parseWorktreeLock(LIST + 'locked\n', '/wt')).toBe('')
    expect(parseWorktreeLock(LIST + 'locked why\n', '/repo')).toBeNull()
  })
})

test('a locked worktree is refused at the first press and nothing runs', async ($, on) => {
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    calls.push(a)
    if (a.startsWith('git log')) return ok(LOG)
    if (a.startsWith('git status --porcelain=v1 -b')) return ok(STATUS)
    if (a.startsWith('git rev-parse --path-format=absolute')) return ok('/wt\n/repo/.git/worktrees/wt\n/repo/.git\nfeat/x\n')
    if (a.startsWith('git worktree list')) {
      return ok('worktree /repo\nHEAD abc\nbranch refs/heads/master\n\nworktree /wt\nHEAD def\nbranch refs/heads/feat/x\nlocked claude session wt (pid 42)\n')
    }
    return ok()
  })
  const ui = await $.ui.mount({ plugin: 'git-tree', surface: 'desktop', component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'wt-close' })
  expect(await ui.find({ type: 'Button', key: 'wt-yes' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /zablokowane \(claude session wt \(pid 42\)\)/ })).toBeDefined()
  expect(calls.some(c => /git (commit|add|merge|branch|worktree (remove|unlock))/.test(c))).toBe(false)
  await ui.unmount()
})

describe('merged branches', () => {
  // origin/master is the base; squashed is merged by squash, old by plain merge, live is not merged
  const REFS = [
    'refs/heads/master\tm1\t',
    'refs/heads/live\tl1\t',
    'refs/remotes/origin/HEAD\tm1\trefs/remotes/origin/master',
    'refs/remotes/origin/master\tm1\t',
    'refs/remotes/origin/squashed\ts1\t',
    'refs/remotes/origin/old\to1\t',
    'refs/remotes/origin/dependabot/npm/x\td1\t',
  ].join('\n')
  const fake = (calls: string[]) => async (argv: string[]) => {
    const a = argv.join(' ')
    calls.push(a)
    const res = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
    if (a.startsWith('git for-each-ref')) return res(REFS)
    if (a === 'git symbolic-ref -q refs/remotes/origin/HEAD') return res('refs/remotes/origin/master\n')
    if (a === 'git symbolic-ref -q HEAD') return res('refs/heads/master\n')
    if (a.startsWith('git rev-parse --symbolic-full-name')) return res('refs/remotes/origin/master\n')
    if (a.startsWith('git merge-base --is-ancestor')) return res('', argv[3] === 'o1' ? 0 : 1)
    if (a.startsWith('git merge-base')) return res('mb\n')
    if (a.startsWith('git rev-parse')) return res(`${(argv[2] ?? '').replace('^{tree}', '')}-tree\n`)
    if (a.startsWith('git commit-tree')) return res(`${argv[2]}-sq\n`)
    if (a.startsWith('git cherry')) return res(argv[3] === 's1-tree-sq' ? '- s1-tree-sq\n' : '+ l1-tree-sq\n')
    return res('', 1)
  }

  test('hides squash- and plain-merged branches, keeps the rest and the main line', async () => {
    const calls: string[] = []
    const cache = new Map<string, boolean>()
    const scan = await scanMerged(fake(calls), cache)
    expect(scan?.base).toBe('refs/remotes/origin/master')
    expect(scan?.hidden).toBe(2)
    expect(scan?.keep.sort()).toEqual(['refs/heads/live', 'refs/heads/master', 'refs/remotes/origin/master'])
    expect(calls.some(c => c.includes('dependabot'))).toBe(false)

    calls.length = 0
    await scanMerged(fake(calls), cache)
    expect(calls.some(c => c.startsWith('git cherry') || c.startsWith('git commit-tree'))).toBe(false)
  })

  test('symbolic refs are skipped', async () => {
    expect(parseRefs('refs/remotes/origin/HEAD\tm1\trefs/remotes/origin/master\nrefs/heads/a\ta1\t')).toEqual([
      { name: 'refs/heads/a', tip: 'a1' },
    ])
  })
})

test('the band keeps what plugins beneath it draw there (next-steps suggestions)', async ($, on) => {
  on('process.run', async (_$, e) => ok(e.argv[1] === 'log' ? LOG : STATUS))
  // stands for next-steps: a plugin beneath ours drawing in the same band
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>next: uruchom testy</Text>
  })
  const pane = await $.ui.mount({ plugin: 'git-tree', surface: 'desktop', component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
  await pane.press({ key: 'refresh' })
  await pane.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'git-tree',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100 } as never,
    })
    const drawn = JSON.stringify(await band.drawn())
    expect(drawn).toContain('next: uruchom testy')
    expect(await band.find({ type: 'Button', key: 'band-tree' })).toBeDefined()
    await band.unmount()
  }
})

describe('handoff (mattpocock-skills)', () => {
  test('finds the skill by its plugin-qualified name; none when not installed', async () => {
    expect(findHandoff([{ name: 'clear' }, { name: 'mattpocock-skills:handoff', plugin: 'mattpocock-skills' }])).toBe('mattpocock-skills:handoff')
    expect(findHandoff([{ name: 'handoff', plugin: 'mattpocock-skills' }])).toBe('handoff')
    expect(findHandoff([{ name: 'handoff-compact:handoff', plugin: 'handoff-compact' }])).toBeNull()
    expect(findHandoff([{ name: 'clear' }])).toBeNull()
  })

  test('one click runs the handoff at once; a second click with nothing new said is blocked', async ($, on) => {
    const runs: string[] = []
    on('process.run', async (_$, e) => ok(e.argv[1] === 'log' ? LOG : STATUS))
    on('command.list', async () => ({
      value: [{ name: 'mattpocock-skills:handoff', description: 'Compact the conversation', source: 'plugin', plugin: 'mattpocock-skills' }] as never,
    }))
    on('command.run', async (_$, e) => {
      runs.push(`/${e.command} ${e.args}`)
      return {}
    })
    const pane = await $.ui.mount({ plugin: 'git-tree', surface: 'desktop', component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
    await pane.press({ key: 'refresh' })
    await pane.unmount()
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({
        plugin: 'git-tree',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120 } as never,
      })
      await band.press({ key: 'band-handoff' })
      // after the first run the button carries a check mark
      expect(JSON.stringify(await band.drawn())).toContain('✓')
      await band.unmount()
    }
    expect(runs).toEqual([`/mattpocock-skills:handoff ${HANDOFF_PURPOSE}`])
    expect(HANDOFF_PURPOSE).toBe('kontynuowanie pracy w nowej sesji')
  })

  test('blocked only after a handoff and until the person says something new', async () => {
    expect(handoffBlocked(0, 0)).toBe(false) // never ran
    expect(handoffBlocked(1_000, 0)).toBe(true) // ran, nothing new since
    expect(handoffBlocked(1_000, 1)).toBe(false) // a new message since
  })
})

describe('loading a handoff from an earlier session', () => {
  const NOW = 1_800_000_000_000
  const file = (name: string, ageMs: number) => ({ name, kind: 'file' as const, mtimeMs: NOW - ageMs })

  test('candidates: Markdown files named handoff, a week old at most, newest first', async () => {
    const got = handoffCandidates(
      [file('notes.md', 1), file('handoff-a.md', 5_000), file('HANDOFF-b.md', 1_000), file('handoff.txt', 1), file('handoff-old.md', HANDOFF_MAX_AGE_MS + 1)],
      NOW,
    )
    expect(got.map(e => e.name)).toEqual(['HANDOFF-b.md', 'handoff-a.md'])
  })

  test('picks the newest document that mentions this repo, across directories', async () => {
    const texts: Record<string, string> = {
      '/tmp/a/handoff-other.md': 'about /work/other-project',
      '/tmp/a/handoff-mine.md': 'see /work/shop for the code',
      '/tmp/handoff-older-mine.md': 'shop again',
    }
    const found = await findHandoffFile({
      dirs: ['/tmp/a/', '/tmp'],
      list: async dir =>
        dir === '/tmp/a/'
          ? [file('handoff-other.md', 10), file('handoff-mine.md', 20)]
          : [file('handoff-older-mine.md', 30)],
      read: async path => texts[path] ?? '',
      marks: ['/work/shop', 'shop'],
      now: NOW,
    })
    expect(found).toEqual({ path: '/tmp/a/handoff-mine.md', mtimeMs: NOW - 20 })
  })

  test('offered only for an earlier session\'s document not loaded yet', async () => {
    const doc = { path: '/tmp/handoff.md', mtimeMs: 1_000 }
    expect(offerLoad(doc, 2_000, null)).toBe(true) // written before this session started
    expect(offerLoad(doc, 500, null)).toBe(false) // this session wrote it
    expect(offerLoad(doc, 2_000, '/tmp/handoff.md')).toBe(false) // already loaded here
    expect(offerLoad(null, 2_000, null)).toBe(false)
    expect(loadHandoffPrompt('/tmp/handoff.md')).toContain('Przeczytaj dokument przekazania /tmp/handoff.md')
  })

  test('the band offers "Załaduj handoff" in place of Handoff and one click sends the pickup', async ($, on) => {
    const submitted: string[] = []
    on('process.run', async (_$, e) => {
      const a = e.argv.join(' ')
      if (a.startsWith('git log')) return ok(LOG)
      if (a.includes('--git-common-dir')) return ok('/work/shop\n/work/shop/.git\n')
      return ok(STATUS)
    })
    on('command.list', async () => ({ value: [{ name: 'mattpocock-skills:handoff', description: '', source: 'plugin', plugin: 'mattpocock-skills' }] as never }))
    on('fs.list', async () => ({ value: [{ name: 'handoff-shop.md', kind: 'file', size: 10, mtimeMs: Date.now() - 60_000, isLink: false }] as never }))
    on('fs.read', async () => ({ value: 'continue work in /work/shop' as never }))
    on('prompt.submit', async (_$, e) => {
      submitted.push(e.text)
      // answer as core does: the prompt that entered, from where
      return { text: e.text, origin: e.origin } as never
    })
    // the session began after the document was written (stamped at the first check)
    const pane = await $.ui.mount({ plugin: 'git-tree', surface: 'desktop', component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
    await pane.press({ key: 'refresh' })
    await pane.unmount()
    const band = await $.ui.mount({
      plugin: 'git-tree',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120 } as never,
    })
    expect(await band.find({ type: 'Button', key: 'band-handoff' })).toBeUndefined()
    await band.press({ key: 'band-load-handoff' })
    expect(submitted).toEqual([loadHandoffPrompt('/tmp/handoff-shop.md')])
    // loaded: the button goes back to Handoff
    expect(await band.find({ type: 'Button', key: 'band-load-handoff' })).toBeUndefined()
    expect(await band.find({ type: 'Button', key: 'band-handoff' })).toBeDefined()
    await band.unmount()
  })
})

test('band above the prompt shows push and pull counts on every surface', async ($, on) => {
  on('process.run', async (_$, e) => ok(e.argv[1] === 'log' ? LOG : '## master...origin/master [ahead 2, behind 3]\n M a.php\n'))
  const pane = await $.ui.mount({ plugin: 'git-tree', surface: 'desktop', component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
  await pane.press({ key: 'refresh' })
  await pane.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'git-tree',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } as never,
    })
    expect(await band.find({ type: 'Button', key: 'band-tree' })).toBeDefined()
    if (surface === 'desktop') {
      // one image of pills plus the tree glyph; the counts live in the image
      expect(await band.findAll({ type: 'Svg' })).toHaveLength(2)
      const drawn = JSON.stringify(await band.drawn())
      expect(drawn).toContain('↑ 2 do push')
      expect(drawn).toContain('↓ 3 do pobrania')
      expect(drawn).toContain('1 zmiana')
    } else {
      expect(await band.find({ type: 'Text', text: /↑2 do push/ })).toBeDefined()
      expect(await band.find({ type: 'Text', text: /↓3 do pobrania/ })).toBeDefined()
      expect(await band.find({ type: 'Text', text: /1 niezacommitowane/ })).toBeDefined()
    }
    await band.unmount()
  }
})

describe('other worktrees with uncommitted changes', () => {
  const LIST = [
    'worktree /repo\nHEAD a\nbranch refs/heads/master',
    'worktree /repo/.claude/worktrees/graf-a\nHEAD b\nbranch refs/heads/test/graf-a',
    'worktree /repo/.claude/worktrees/graf-b\nHEAD c\nbranch refs/heads/test/graf-b',
    'worktree /gone\nHEAD d\nbranch refs/heads/old\nprunable gitdir file points to non-existent location',
  ].join('\n\n')
  const fake = async (argv: string[], cwd?: string) => {
    const res = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
    const a = argv.join(' ')
    if (a.startsWith('git worktree list')) return res(LIST)
    if (a.startsWith('git rev-parse')) return res('/repo/.claude/worktrees/graf-b\n')
    if (cwd === '/repo') return res(' M a.php\n')
    if (cwd === '/repo/.claude/worktrees/graf-a') return res(' M x\n?? y\n')
    return res(' M z\n')
  }

  test('lists every worktree but prunable ones, main first', async () => {
    expect(parseWorktreeList(LIST).map(w => [w.path, w.branch, w.isMain])).toEqual([
      ['/repo', 'master', true],
      ['/repo/.claude/worktrees/graf-a', 'test/graf-a', false],
      ['/repo/.claude/worktrees/graf-b', 'test/graf-b', false],
    ])
  })

  test('counts changes in the others, not in the one the session is in', async () => {
    const list = await dirtyWorktrees(fake)
    expect(list.map(w => [w.name, w.dirty])).toEqual([
      ['repo główne', 1],
      ['graf-a', 2],
    ])
    expect(dirtyWorktreesLabel(list)).toBe('repo główne ●1 · graf-a ●2')
  })
})

test('band names the other worktrees that hold uncommitted changes', async ($, on) => {
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.startsWith('git log')) return ok(LOG)
    if (a.startsWith('git worktree list')) return ok('worktree /repo\nHEAD a\nbranch refs/heads/master\n\nworktree /wt/graf-c\nHEAD b\nbranch refs/heads/test/graf-c\n')
    if (a.startsWith('git rev-parse --path-format=absolute --show-toplevel') && a.endsWith('--show-toplevel')) return ok('/repo\n')
    if (a.startsWith('git status --porcelain') && e.init?.cwd === '/wt/graf-c') return ok(' M a\n?? b\n')
    return ok('## master...origin/master\n')
  })
  const pane = await $.ui.mount({ plugin: 'git-tree', surface: 'desktop', component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
  await pane.press({ key: 'refresh' })
  await pane.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'git-tree',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } as never,
    })
    if (surface === 'desktop') {
      expect(JSON.stringify(await band.drawn())).toContain('graf-c')
    } else {
      expect(await band.find({ type: 'Text', text: /niezacommitowane w worktree:.*graf-c ●2/ })).toBeDefined()
    }
    await band.unmount()
  }
})

describe('band pills', () => {
  const base = { branch: 'master', isWorktree: false, hasUpstream: true, ahead: 0, behind: 0, dirty: 0, others: [], prs: null }
  test('PR pill: counts in colour when there is work, grey zeros when none, no pill when unknown', async () => {
    const busy = renderBand({ ...base, prs: { toReview: 2, changesRequested: 1 } }).source
    expect(busy).toContain('2 do review')
    expect(busy).toContain('1 do poprawy')
    expect(busy).toContain('class="fg-red"')
    const calm = renderBand({ ...base, prs: { toReview: 0, changesRequested: 0 } }).source
    expect(calm).toContain('0 do review')
    expect(calm).not.toContain('class="fg-red"')
    expect(renderBand(base).source).not.toContain('do review')
  })
  test('a synced branch turns its own pill green, no separate pill; counts and plurals otherwise', async () => {
    const synced = renderBand(base).source
    expect(synced).toContain('<rect class="bg-green"')
    expect(synced).not.toContain('aktualne')
    expect(synced.match(/<rect /g)).toHaveLength(1)
    const ahead = renderBand({ ...base, ahead: 1 }).source
    expect(ahead).toContain('<rect class="bg-plain"')
    expect(ahead).not.toContain('<rect class="bg-green"')
    const busy = renderBand({ ...base, ahead: 2, behind: 5, dirty: 12 }).source
    expect(busy).toContain('↑ 2 do push')
    expect(busy).toContain('↓ 5 do pobrania')
    expect(busy).toContain('12 zmian')
    expect(busy).not.toContain('aktualne')
    expect(plural(3, 'zmiana', 'zmiany', 'zmian')).toBe('zmiany')
    expect(plural(22, 'zmiana', 'zmiany', 'zmian')).toBe('zmiany')
    expect(plural(13, 'zmiana', 'zmiany', 'zmian')).toBe('zmian')
  })
  test('other worktrees: named up to four, counted past that; names are escaped', async () => {
    const few = renderBand({ ...base, others: [{ name: 'graf-a', dirty: 2 }, { name: '<x>', dirty: 1 }] }).source
    expect(few).toContain('graf-a')
    expect(few).toContain('&lt;x&gt;')
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `w${i}`, dirty: 1 }))
    expect(renderBand({ ...base, others: many }).source).toContain('6 worktree ze zmianami')
  })
  test('the image is as wide as its pills', async () => {
    const short = renderBand(base)
    const long = renderBand({ ...base, branch: 'feature/a-much-longer-branch-name' })
    expect(long.width).toBeGreaterThan(short.width)
    expect(short.source).toContain(`width="${short.width}"`)
  })
})

test('heavy letters: Latin and digits; letters with diacritics and the rest unchanged', async () => {
  expect(boldSans('AZ az 09')).toBe('𝗔𝗭 𝗮𝘇 𝟬𝟵')
  expect(boldSans('Wyjaśnij z Claude')).toBe('𝗪𝘆𝗷𝗮ś𝗻𝗶𝗷 𝘇 𝗖𝗹𝗮𝘂𝗱𝗲')
  expect(boldSans('#1 ✨')).toBe('#𝟭 ✨')
})

test('status dots use GitHub colours and carry their letter', async () => {
  expect(statusDot('M')).toContain('#D29922')
  expect(statusDot('A')).toContain('#3FB950')
  expect(statusDot('D')).toContain('#F85149')
  expect(statusDot('M')).toContain('>M</text>')
})

describe('pull requests', () => {
  const row = (number: number, login: string, type = 'User', repo = 'me/app', updatedAt = '2026-10-01T10:00:00Z') => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    updatedAt,
    repository: { nameWithOwner: repo },
    author: { login, type, is_bot: false },
  })

  test('the two searches merge into one list, most recently active first', async () => {
    const requested = [row(1, 'ala', 'User', 'acme/app', '2026-10-01T00:00:00Z')]
    const inMyRepos = [row(2, 'ola', 'User', 'me/app', '2026-10-09T00:00:00Z')]
    expect(toReview(requested, inMyRepos, 'me').map(p => p.number)).toEqual([2, 1])
  })

  test('the band links straight to the newest PR of each kind', async ($, on) => {
    on('process.run', async (_$, e) => {
      const a = e.argv.join(' ')
      if (a.startsWith('gh api user')) return ok('me\n')
      if (a.includes('--review-requested=@me')) return ok('[]')
      if (a.includes('--owner=me')) {
        return ok(JSON.stringify([row(9, 'ola', 'User', 'me/app', '2026-10-02T00:00:00Z'), row(11, 'ala', 'User', 'me/app', '2026-10-08T00:00:00Z')]))
      }
      if (a.includes('--review=changes_requested')) return ok(JSON.stringify([row(53, 'me')]))
      if (a.startsWith('git log')) return ok(LOG)
      return ok(STATUS)
    })
    const pane = await $.ui.mount({ plugin: 'git-tree', surface: 'desktop', component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
    await pane.press({ key: 'refresh' })
    await pane.unmount()
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({
        plugin: 'git-tree',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120 } as never,
      })
      const drawn = JSON.stringify(await band.drawn())
      expect(drawn).toContain('https://github.com/me/app/pull/11') // newest to review
      expect(drawn).not.toContain('/pull/9"')
      expect(drawn).toContain('https://github.com/me/app/pull/53')
      expect(drawn).toContain('↗ #53 do poprawy')
      await band.unmount()
    }
  })

  test('to review: requests to me and PRs by people in my repos; bots, mine and repeats left out', async () => {
    const requested = [row(7, 'ala', 'User', 'acme/app')]
    const inMyRepos = [row(123, 'dependabot[bot]', 'Bot'), row(5, 'me'), row(9, 'ola'), row(7, 'ala', 'User', 'acme/app')]
    expect(toReview(requested, inMyRepos, 'me').map(p => `${p.repo}#${p.number}`)).toEqual(['acme/app#7', 'me/app#9'])
    expect(isBot({ login: 'dependabot[bot]', is_bot: false })).toBe(true)
    expect(isBot({ login: 'renovate', type: 'Bot' })).toBe(true)
    expect(parseSearch('not json')).toEqual([])
  })

  test('the pane lists them as links, sent back first', async ($, on) => {
    on('process.run', async (_$, e) => {
      const a = e.argv.join(' ')
      if (a.startsWith('gh api user')) return ok('me\n')
      if (a.includes('--review-requested=@me')) return ok(JSON.stringify([row(7, 'ala', 'User', 'acme/app')]))
      if (a.includes('--owner=me')) return ok(JSON.stringify([row(123, 'dependabot[bot]', 'Bot')]))
      if (a.includes('--review=changes_requested')) return ok(JSON.stringify([row(53, 'me')]))
      if (a.startsWith('git log')) return ok(LOG)
      return ok(STATUS)
    })
    const ui = await $.ui.mount({ plugin: 'git-tree', surface: 'desktop', component: 'Pane', requestId: 'git-tree', props: PANE_PROPS })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /Do poprawy po review/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Czekają na Twoje review \(1\)/ })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).toContain('https://github.com/acme/app/pull/7')
    expect(JSON.stringify(await ui.drawn())).not.toContain('/pull/123')
    await ui.unmount()
  })
})

test('the band says nothing about when it last checked GitHub', async () => {
  const base = { branch: 'master', isWorktree: false, hasUpstream: true, ahead: 0, behind: 0, dirty: 0, others: [], prs: null }
  expect(renderBand(base).source).not.toContain('sprawdzone')
})
