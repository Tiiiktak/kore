import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { SharePage } from '@/components/share/SharePage'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import { applyTheme } from '@/lib/theme'

applyTheme()

// /s/<token> is a share link: the one-file app renders only the share view there.
const shareToken = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname)?.[1]

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      {shareToken ? <SharePage token={shareToken} /> : <App />}
      <Toaster />
    </TooltipProvider>
  </StrictMode>,
)
