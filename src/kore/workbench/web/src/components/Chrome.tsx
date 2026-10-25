import { Home, PanelLeft } from 'lucide-react'
import { SettingsMenu } from '@/components/SettingsMenu'
import { Hint } from '@/components/Hint'
import { WorkspaceTabs } from '@/components/wm/WorkspaceTabs'
import { toggleTabSide } from '@/lib/layout'
import { flipCapture } from '@/lib/wm/flip'
import { BrandMark } from '@/components/BrandMark'
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
  const { roster, fetchedAt } = useRosterCtx()
  const mobile = useIsMobile()
  const left = orientation === 'left'
  const home = wmStore.get().view === 'home'
  const visible = wmStore.visibleSessionKeys()
  // via effectiveState so "已处理即消闪" (markActed) also quiets the sidebar alert, not just cards
  const needsYou = !!roster?.sessions?.some((s) => effectiveState(s, visible, fetchedAt) === 'waiting')
  const doneSomewhere = !needsYou && !!roster?.sessions?.some((s) => effectiveState(s, visible, fetchedAt) === 'done')

  return (
    <nav
      className={cn(
        // No background / border: the nav is just a transparent container over the one shared
        // background. Only the controls inside move (FLIP) when the side flips.
        'absolute top-0 left-0 z-10 flex',
        left ? 'h-full w-[228px] flex-col gap-1 p-2' : 'h-[46px] w-full items-center gap-2 px-2',
      )}
    >
      {/* leading: brand mark flush-left, then the wordmark, then the layout toggle (desktop) */}
      {/* logo + wordmark + toggle each FLIP individually: the cluster's own box barely moves,
          but the left-only pl-2.5 indent shifts the glyphs INSIDE it — a container-level FLIP
          can't see that, so each element carries its own key and slides to its real position. */}
      <div className={cn('flex items-center gap-1.5', left && 'pb-0.5 pl-2.5')}>
        {/* brand mark: the ▐▛▜▌/▝▜▛▘ quadrant glyphs as vector sub-pixels (square, crisp,
            theme-aware via currentColor) — same shape as the favicon. */}
        <BrandMark
          data-flip="nav-logo"
          animate="hover"
          className="size-[18px] shrink-0 text-[var(--claude)] select-none"
        />
        {!mobile && <span data-flip="nav-wordmark" className="text-[15px] font-semibold tracking-tight">kore</span>}
        {!mobile && (
          <Hint label={left ? '标签栏放到顶部' : '标签栏放到左侧'}>
            <button
              data-flip="nav-toggle"
              onClick={() => {
                flipCapture()
                toggleTabSide()
              }}
              aria-label={left ? '标签栏放到顶部' : '标签栏放到左侧'}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-md"
            >
              <PanelLeft className="size-4" />
            </button>
          </Hint>
        )}
      </div>

      {/* overview / home — icon-only (horizontal) gets a hint; the vertical form shows "总览" text */}
      <Hint label={left ? '' : '总览'}>
      <button
        data-flip="nav-overview"
        onClick={() => wmStore.setView('home')}
        aria-label="总览"
        className={cn(
          'relative flex h-9 items-center gap-2.5 rounded-md text-sm transition-colors',
          left ? 'w-full px-2.5' : 'w-9 justify-center',
          home ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <Home className="size-4 shrink-0" />
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
      </Hint>

      {/* tabs; on mobile settings rides at the end so it scrolls with the + */}
      <WorkspaceTabs vertical={left} trailing={mobile ? <SettingsMenu /> : undefined} />

      {/* trailing: version + settings (desktop only) */}
      {!mobile &&
        (left ? (
          <>
            <div className="flex-1" />
            <div className="flex items-center justify-between pl-2.5 pr-1">
              {version && <span data-flip="nav-version" className="text-muted-foreground text-xs tabular-nums">{version}</span>}
              <span data-flip="nav-settings" className="inline-flex">
                <SettingsMenu />
              </span>
            </div>
          </>
        ) : (
          <>
            {version && <span data-flip="nav-version" className="text-muted-foreground mr-1 text-xs tabular-nums">{version}</span>}
            <span data-flip="nav-settings" className="inline-flex">
              <SettingsMenu />
            </span>
          </>
        ))}
    </nav>
  )
}
