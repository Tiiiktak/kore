// Shapes returned by the kore board backend (/api/kore/roster etc.).

export type SessionState = 'busy' | 'waiting' | 'idle' | 'tmux_only' | 'dead' | string

export interface Session {
  name: string
  node_ip: string
  state: SessionState
  state_since?: number // epoch secs this idle/busy stretch began (from the hook record)
  state_detail?: string
  writable: boolean
  protected?: boolean
  write_block?: string
  is_self?: boolean
  job_name?: string
  gpus?: number
  role?: string
  cwd?: string // create-time value from the registry (often stale); prefer live_cwd
  summary?: string
  // live tmux facts (active pane of the active window), surfaced on the overview cards
  windows?: number // number of tmux windows in the session
  panes?: number // number of panes in the active window
  command?: string // active pane's current command (e.g. "claude", "vim")
  title?: string // active pane title
  live_cwd?: string // active pane's current directory (fresh, unlike cwd)
}

export interface NodeInfo {
  node_ip: string
  self: boolean
  hostname: string
  agent_started?: number // client agent process start epoch; changes when it restarts
  pid?: number
}

export interface Labels {
  nodes: Record<string, { name?: string; icon?: string }>
  sessions: Record<string, { name?: string; icon?: string }>
}

export interface Roster {
  ok: boolean
  sessions: Session[]
  nodes: NodeInfo[]
  prefix: string
  version?: string
  labels?: Labels
  stale?: boolean
  error?: string
  fetched_at?: number
  session_count?: number
  unreachable_nodes?: string[]
}
