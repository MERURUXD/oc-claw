import Mini from './Mini'
import { DemoMascot } from './DemoMascot'
import HermesBubbles from './HermesBubbles'

function App() {
  // Demo mascot windows load `index.html#/mini?demo=1&pet=<id>` so they
  // share the bundle with the main mini window but render a stripped
  // mascot-only tree.
  const hash = typeof window !== 'undefined' ? window.location.hash : ''
  const isDemo = /[?&]demo=1\b/.test(hash)
  // Extra mascots (coding-mode "multi-mascot" feature) reuse the same mascot
  // window but are fully functional: clicking one expands the main panel.
  const isExtra = /[?&]extra=1\b/.test(hash)
  // Standalone Hermes bubble window (coding mode): dumb bubble-only renderer,
  // fed by the Mini window over the `hermes-bubble-data` event.
  if (/[?&]bubbles=1\b/.test(hash)) return <HermesBubbles />
  if (isDemo || isExtra) return <DemoMascot functional={isExtra} />
  return <Mini />
}

export default App
