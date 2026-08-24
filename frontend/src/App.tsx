import Mini from './Mini'
import { DemoMascot } from './DemoMascot'
import MascotBubble from './components/MascotBubble'

function App() {
  // Demo mascot windows load `index.html#/mini?demo=1&pet=<id>` so they
  // share the bundle with the main mini window but render a stripped
  // mascot-only tree.
  const hash = typeof window !== 'undefined' ? window.location.hash : ''
  const isDemo = /[?&]demo=1\b/.test(hash)
  // Extra mascots (coding-mode "multi-mascot" feature) reuse the same mascot
  // window but are fully functional: clicking one expands the main panel.
  const isExtra = /[?&]extra=1\b/.test(hash)
  if (isDemo || isExtra) return <DemoMascot functional={isExtra} />
  // Mascot status bubble window (`index.html#/mascot-bubble`) — a small
  // transparent always-on-top window anchored next to the primary mascot that
  // renders a one-line agent status summary. Passive: it only renders what
  // Mini.tsx emits and measures its own size.
  if (hash.startsWith('#/mascot-bubble')) return <MascotBubble />
  return <Mini />
}

export default App
