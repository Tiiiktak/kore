import { Home, PanelLeft } from 'lucide-react'
import { SettingsMenu } from '@/components/SettingsMenu'
import { WorkspaceTabs } from '@/components/wm/WorkspaceTabs'
import { toggleTabSide } from '@/lib/layout'
import { useWmVersion, wmStore } from '@/lib/wm/store'
import { useRosterCtx } from '@/lib/roster-context'
import { effectiveState, useSeenVersion } from '@/lib/seen'
import { useIsMobile } from '@/hooks/useIsMobile'
import { cn } from '@/lib/utils'

// The navigation chrome. Top bar and side rail are the SAME thing — one layout rotated — so
// every control shares one size set; `orientation` only changes the flex direction. The brand
// sits flush-left at the same x in both orientations (so toggling doesn't shift it). On mobile
// App forces 'top': the layout toggle and the brand word drop, and settings rides at the end of
// the (scrollable) tab strip next to the + so it never crowds the scarce width.
export function Chrome({ version, orientation }: { version?: string; orientation: 'top' | 'left' }) {
  useWmVersion()
  useSeenVersion()
  const { roster } = useRosterCtx()
  const mobile = useIsMobile()
  const left = orientation === 'left'
  const home = wmStore.get().view === 'home'
  const needsYou = !!roster?.sessions?.some((s) => s.state === 'waiting')
  const visible = wmStore.visibleSessionKeys()
  const doneSomewhere = !needsYou && !!roster?.sessions?.some((s) => effectiveState(s, visible) === 'done')

  return (
    <nav
      className={cn(
        'bg-background flex shrink-0',
        left ? 'w-[228px] flex-col gap-1 border-r p-2' : 'h-[46px] items-center gap-2 border-b px-2',
      )}
    >
      {/* leading: brand mark flush-left, then the layout toggle (desktop), then the wordmark */}
      <div className={cn('flex items-center gap-1.5', left && 'pb-0.5')}>
        <span className="font-mono text-[9px] leading-[0.8] whitespace-pre text-[var(--claude)] select-none">
          {' ▐▛▜▌\n▝▜▛▘'}
        </span>
        {!mobile && (
          <button
            onClick={toggleTabSide}
            aria-label={left ? '标签栏放到顶部' : '标签栏放到左侧'}
            title={left ? '标签栏放到顶部' : '标签栏放到左侧'}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-md"
          >
            <PanelLeft className="size-[18px]" />
          </button>
        )}
        {!mobile && <span className="text-[15px] font-semibold tracking-tight">kore</span>}
      </div>

      {/* overview / home */}
      <button
        onClick={() => wmStore.setView('home')}
        aria-label="总览"
        title="总览"
        className={cn(
          'relative flex h-9 items-center gap-2.5 rounded-md text-sm transition-colors',
          left ? 'w-full px-2.5' : 'w-9 justify-center',
          home ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <Home className="size-[18px] shrink-0" />
        {left && '总览'}
        {needsYou ? (
          <span
            className="kore-blink absolute top-1 right-1 size-2 rounded-full"
            style={{ background: 'var(--busy)', boxShadow: '0 0 0 2px var(--background)' }}
            title="有会话需要你回复"
            aria-label="有会话需要你回复"
          />
        ) : doneSomewhere ? (
          <span
            className="absolute top-1 right-1 size-2 rounded-full"
            style={{ background: 'var(--done)', boxShadow: '0 0 0 2px var(--background)' }}
            title="有会话刚完成，去看看"
            aria-label="有会话刚完成"
          />
        ) : null}
      </button>

      {left && <div className="bg-border/60 my-1 h-px" />}

      {/* tabs; on mobile settings rides at the end so it scrolls with the + */}
      <WorkspaceTabs vertical={left} trailing={mobile ? <SettingsMenu /> : undefined} />

      {/* trailing: version + settings (desktop only) */}
      {!mobile &&
        (left ? (
          <>
            <div className="flex-1" />
            <div className="flex items-center justify-between px-1">
              {version && <span className="text-muted-foreground text-xs tabular-nums">{version}</span>}
              <SettingsMenu />
            </div>
          </>
        ) : (
          <>
            {version && <span className="text-muted-foreground mr-1 text-xs tabular-nums">{version}</span>}
            <SettingsMenu />
          </>
        ))}
    </nav>
  )
}
