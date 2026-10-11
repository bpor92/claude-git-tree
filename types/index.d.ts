export type Commit = {
  hash: string
  parents: string[]
  refs: string[]
  ts: number
  author: string
  subject: string
}

export type RepoStatus = {
  branch: string
  tracking?: string
  dirty: number
  /** Commits on this branch not yet on its upstream (to push). */
  ahead: number
  /** Commits on the upstream not yet here (to pull). */
  behind: number
}

export type WorktreeInfo = {
  path: string
  branch: string
  mainPath: string
  mainBranch: string
}

/** Another worktree of the repo with uncommitted changes. */
export type OtherWorktree = {
  /** The folder's name, or "repo główne" for the main checkout. */
  name: string
  path: string
  branch: string
  /** How many files `git status` lists as changed or new. */
  dirty: number
}

/** `updatedAt` is GitHub's ISO time of the last activity; lists run newest first. */
export type PrRef = { repo: string; number: number; title: string; url: string; updatedAt: string }

export type PrSummary = {
  /** Review requests to you, and open PRs by other people (not bots) in your repos. */
  toReview: PrRef[]
  /** Your open PRs whose review asked for changes. */
  changesRequested: PrRef[]
}

export type CloseState =
  | { phase: 'idle' }
  | { phase: 'confirm' }
  | { phase: 'running' }
  | { phase: 'done'; ok: boolean; message: string; steps: string[] }

export type ChangedFile = {
  /** A, M, D, R (renamed), C (copied), T (type changed). */
  status: string
  path: string
  /** The old path of a rename or copy. */
  from?: string
  /** null for a binary file. */
  added: number | null
  deleted: number | null
}

export type CommitDetail = { hash: string; files: ChangedFile[]; isLoading?: boolean; error?: string }

export type FileDiff = { hash: string; path: string; diff: string | null }

declare module 'claude-code' {
  interface PluginState {
    'git-tree': {
      commits: Commit[]
      status: RepoStatus | null
      error: string | null
      updatedAt: number
      worktree: WorktreeInfo | null
      /** The repo's other worktrees with uncommitted changes, for the band above the prompt. */
      dirtyWorktrees: OtherWorktree[]
      /** Pull requests needing you, from GitHub; null until known or when `gh` cannot answer. */
      prs: PrSummary | null
      close: CloseState
      hideMerged: boolean
      /** How many merged branches the last scan hid; null before the first scan or when shown. */
      hiddenCount: number | null
      /** The commit clicked open in the graph, its files loading (`files: []`) or loaded. */
      selected: CommitDetail | null
      /** The file clicked open inside the selected commit; `diff` null while it loads. */
      openFile: FileDiff | null
    }
  }
}
