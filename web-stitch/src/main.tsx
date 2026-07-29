import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './typography.css'
import './components/files/file-intelligence.css'
import './components/outputs/editable-output.css'
import './features/copilot/copilot-cards.css'
import './features/agents/agent-workspace.css'
import App from './App.tsx'
import { AppErrorBoundary } from './app/AppErrorBoundary.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
)
