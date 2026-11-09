import { useSyncExternalStore } from 'react'

// The one notification door. Everything that wants to alert the user (a session needs you, a
// turn just finished, …) calls notify(); it filters by the user's per-event prefs and fans the
// event out to every enabled channel. Channels are pluggable — browser (Notification API) and
// sound (WebAudio beep) ship today; a future webhook / push / Bark channel just pushes into
// `channels`. Settings persist like the other prefs (localStorage + module store, cf. theme.ts).

export interface NotifySettings {
  browser: boolean // OS notification via the Notification API
  sound: boolean // short WebAudio beep
  events: { waiting: boolean; done: boolean } // which transitions fire a notification
}

const KEY = 'kore.notify.v1'
const DEFAULTS: NotifySettings = { browser: false, sound: false, events: { waiting: true, done: false } }

function load(): NotifySettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (v && typeof v === 'object')
      return {
        browser: !!v.browser,
        sound: !!v.sound,
        events: {
          waiting: v.events?.waiting ?? DEFAULTS.events.waiting,
          done: v.events?.done ?? DEFAULTS.events.done,
        },
      }
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS, events: { ...DEFAULTS.events } }
}

let settings = load()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}
export function getNotifySettings(): NotifySettings {
  return settings
}
type NotifyPatch = Partial<Omit<NotifySettings, 'events'>> & { events?: Partial<NotifySettings['events']> }
export function setNotifySettings(patch: NotifyPatch): NotifySettings {
  settings = { ...settings, ...patch, events: { ...settings.events, ...(patch.events || {}) } }
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* ignore */
  }
  emit()
  return settings
}
export function useNotifySettings(): NotifySettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => settings,
  )
}

// --- capability / permission ----------------------------------------------------------------
// The Notification API needs a SECURE CONTEXT: HTTPS, or a localhost/127.0.0.1 origin. A board
// opened over plain HTTP on a LAN IP (the common `http://<ip>:8198/?token=` link) can't notify —
// a browser limitation kore can't route around. UI greys the toggle and says so in that case.
export function canNotify(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext === true
}
export function notifyPermission(): NotificationPermission | 'unsupported' {
  return canNotify() ? Notification.permission : 'unsupported'
}
export async function requestNotifyPermission(): Promise<boolean> {
  if (!canNotify()) return false
  if (Notification.permission === 'granted') return true
  try {
    return (await Notification.requestPermission()) === 'granted'
  } catch {
    return false
  }
}

// --- channels -------------------------------------------------------------------------------
export interface NotifyEvent {
  kind: 'waiting' | 'done'
  key: string // session key — also the Notification tag, so a session's alert replaces its own
  title: string
  body: string
  onClick?: () => void
}
export interface Channel {
  id: string
  enabled(): boolean
  deliver(e: NotifyEvent): void
}

const browserChannel: Channel = {
  id: 'browser',
  enabled: () => settings.browser && canNotify() && Notification.permission === 'granted',
  deliver(e) {
    try {
      const n = new Notification(e.title, { body: e.body, tag: e.key })
      n.onclick = () => {
        try {
          window.focus()
        } catch {
          /* ignore */
        }
        e.onClick?.()
        n.close()
      }
    } catch {
      /* ignore */
    }
  },
}

// Synthesize the beep rather than ship an audio file — the build inlines everything into one
// index.html, so a tone generator keeps that single file free of embedded binary.
let audio: AudioContext | null = null
function beep(kind: NotifyEvent['kind']) {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return
    if (!audio) audio = new Ctx()
    if (audio.state === 'suspended') void audio.resume()
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    const t = audio.currentTime
    osc.type = 'sine'
    osc.frequency.value = kind === 'waiting' ? 880 : 587 // A5 for "需要你", D5 for "刚完成"
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
    osc.connect(gain).connect(audio.destination)
    osc.start(t)
    osc.stop(t + 0.32)
  } catch {
    /* ignore */
  }
}
const soundChannel: Channel = {
  id: 'sound',
  enabled: () => settings.sound,
  deliver: (e) => beep(e.kind),
}

const channels: Channel[] = [browserChannel, soundChannel]

// The single entry point. Drop an event here; enabled + event-allowed channels pick it up.
export function notify(e: NotifyEvent): void {
  if (!settings.events[e.kind]) return
  for (const c of channels) if (c.enabled()) c.deliver(e)
}
