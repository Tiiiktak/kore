import { useSyncExternalStore } from 'react'

// Workspace-tab grouping. The nav tab strip can group the open workspaces three ways:
//   'none'    — flat list (default; identical to before this feature)
//   'machine' — auto-grouped by the machine of a workspace's first terminal (derived, not stored)
//   'custom'  — user-defined named groups; a workspace's group id lives on the Workspace itself
// Mode + the custom group list + per-header collapse state persist here (module store +
// localStorage, same shape as layout.ts / theme.ts). Collapse keys: node_ip in 'machine' mode,
// group id in 'custom' mode (plus the sentinels below for the catch-all sections).

export type GroupMode = 'none' | 'machine' | 'custom'
export interface CustomGroup {
  id: string
  name: string
}
export interface TabGroupState {
  mode: GroupMode
  groups: CustomGroup[]
  collapsed: Record<string, boolean>
}

// catch-all section keys
export const UNGROUPED = '__ungrouped__' // custom mode: workspaces with no group
export const NO_MACHINE = '__nomachine__' // machine mode: workspaces with no terminal

const KEY = 'kore.tabgroups.v1'

function load(): TabGroupState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (v && typeof v === 'object')
      return {
        mode: v.mode === 'machine' || v.mode === 'custom' ? v.mode : 'none',
        groups: Array.isArray(v.groups)
          ? v.groups.filter((g: any) => g && typeof g.id === 'string' && typeof g.name === 'string').map((g: any) => ({ id: g.id, name: g.name }))
          : [],
        collapsed: v.collapsed && typeof v.collapsed === 'object' ? v.collapsed : {},
      }
  } catch {
    /* ignore */
  }
  return { mode: 'none', groups: [], collapsed: {} }
}

let state = load()
const listeners = new Set<() => void>()
let gseq = 1

function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
  for (const l of listeners) l()
}

export function getTabGroups(): TabGroupState {
  return state
}
export function useTabGroups(): TabGroupState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

export function setMode(mode: GroupMode) {
  state = { ...state, mode }
  commit()
}
export function toggleCollapse(k: string) {
  state = { ...state, collapsed: { ...state.collapsed, [k]: !state.collapsed[k] } }
  commit()
}
export function isCollapsed(k: string): boolean {
  return !!state.collapsed[k]
}

// Create a custom group and return its id (so the caller can immediately assign a tab to it).
export function addGroup(name: string): string {
  const id = 'g' + Date.now().toString(36) + (gseq++).toString(36)
  state = { ...state, groups: [...state.groups, { id, name: name.trim() || '分组' }] }
  commit()
  return id
}
export function renameGroup(id: string, name: string) {
  state = { ...state, groups: state.groups.map((g) => (g.id === id ? { ...g, name: name.trim() || g.name } : g)) }
  commit()
}
export function removeGroup(id: string) {
  state = { ...state, groups: state.groups.filter((g) => g.id !== id) }
  commit()
}
