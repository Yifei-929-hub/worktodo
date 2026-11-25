import { createRoot } from 'react-dom/client'
import type { Api } from '../shared/types'
import { App } from './App'
import { Float } from './Float'
import './styles.css'

declare global {
  interface Window {
    worktodo: Api
  }
}

createRoot(document.getElementById('root')!).render(location.hash === '#float' ? <Float /> : <App />)
