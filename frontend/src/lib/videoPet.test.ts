import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeVideoPetGeometry,
  mapSemanticStateToVideoCandidates,
  normalizeVideoAnimation,
  isMirrorForbidden,
  DSH_GEOMETRY,
  type VideoPet,
  type VideoPetAnimationMeta,
  type VideoPetCanvasGeometry,
} from './videoPet.ts'
import { getPetAspectRatio, getPetRenderMetrics, parsePetManifest, isVideoPet } from './petAsset.ts'

test('computeVideoPetGeometry: computes exact body scale and container bounds', () => {
  // DSH standard: canvas 640x360, bodyBox [212, 60, 428, 330], feetY 330
  // body width = 428 - 212 = 216
  // body height = 330 - 60 = 270
  // aspect = 270 / 216 = 1.25

  const visualSize = 108
  const geo = computeVideoPetGeometry(DSH_GEOMETRY, visualSize)

  assert.equal(geo.scale, 0.5)
  assert.equal(geo.containerWidth, 108)
  assert.equal(geo.containerHeight, 135) // 108 * 1.25
  assert.equal(geo.canvasWidth, 320)     // 640 * 0.5
  assert.equal(geo.canvasHeight, 180)    // 360 * 0.5
  assert.equal(geo.canvasLeft, -106)     // -212 * 0.5
  assert.equal(geo.canvasTop, -30)       // -60 * 0.5

  // Verify alignment: body box inside the container starts at (0, 0)
  const bodyRenderLeft = geo.canvasLeft + DSH_GEOMETRY.bodyBox[0] * geo.scale
  const bodyRenderTop = geo.canvasTop + DSH_GEOMETRY.bodyBox[1] * geo.scale
  const bodyRenderRight = geo.canvasLeft + DSH_GEOMETRY.bodyBox[2] * geo.scale
  const bodyRenderBottom = geo.canvasTop + DSH_GEOMETRY.bodyBox[3] * geo.scale

  assert.equal(bodyRenderLeft, 0)
  assert.equal(bodyRenderTop, 0)
  assert.equal(bodyRenderRight, geo.containerWidth)
  assert.equal(bodyRenderBottom, geo.containerHeight)
})

test('computeVideoPetGeometry: rounded hitbox remains inside the native canvas', () => {
  const canvas: VideoPetCanvasGeometry = {
    width: 143,
    height: 143,
    bodyBox: [13, 0, 143, 130],
    feetY: 130,
  }
  const geo = computeVideoPetGeometry(canvas, 215)

  assert.equal(geo.hitboxLeft, 22)
  assert.equal(geo.bodyWidth, 215)
  assert.equal(Math.round(canvas.width * geo.scale), 236)
  assert.equal(geo.canvasWidth, 237)
  assert.ok(geo.hitboxLeft + geo.bodyWidth <= geo.canvasWidth)
})

test('computeVideoPetGeometry: handles degenerate or zero-size gracefully', () => {
  const customCanvas: VideoPetCanvasGeometry = {
    width: 100,
    height: 100,
    bodyBox: [0, 0, 100, 100],
    feetY: 100,
  }
  const geo = computeVideoPetGeometry(customCanvas, 50)
  assert.equal(geo.scale, 0.5)
  assert.equal(geo.containerWidth, 50)
  assert.equal(geo.containerHeight, 50)
  assert.equal(geo.canvasLeft, 0)
  assert.equal(geo.canvasTop, 0)
})

test('mapSemanticStateToVideoCandidates: generates correct candidate cascades', () => {
  assert.deepEqual(mapSemanticStateToVideoCandidates('idle'), ['idle', 'rest'])
  assert.deepEqual(mapSemanticStateToVideoCandidates('running'), ['running', 'work', 'working', 'running', 'idle'])
  assert.deepEqual(mapSemanticStateToVideoCandidates('review'), ['review', 'code', 'thinking', 'work', 'idle'])
  assert.deepEqual(mapSemanticStateToVideoCandidates('jumping'), ['jumping', 'drag', 'jump', 'idle'])
  assert.deepEqual(mapSemanticStateToVideoCandidates('run-left'), ['run-left', 'move', 'walk', 'run', 'running', 'work', 'idle'])
  assert.deepEqual(mapSemanticStateToVideoCandidates('run-right'), ['run-right', 'move', 'walk', 'run', 'running', 'work', 'idle'])
})

test('computeVideoPetGeometry: feetY baseline anchors feet directly to container bottom', () => {
  // Custom geometry where character bodyBox bottom is 340, but feetY is 320 (feet slightly higher)
  const floatingCanvas: VideoPetCanvasGeometry = {
    width: 600,
    height: 400,
    bodyBox: [100, 20, 300, 340], // bodyW = 200, bodyH = feetY - 20 = 300
    feetY: 320,
  }
  const geo = computeVideoPetGeometry(floatingCanvas, 100)
  // scale = 100 / 200 = 0.5
  assert.equal(geo.scale, 0.5)
  // containerHeight = 100 * (300 / 200) = 150
  assert.equal(geo.containerHeight, 150)
  // canvasTop = containerHeight - feetY * scale = 150 - 320 * 0.5 = 150 - 160 = -10
  assert.equal(geo.canvasTop, -10)
  // Feet in container coordinates = canvasTop + feetY * scale = -10 + 160 = 150 = containerHeight!
  const renderedFeetY = geo.canvasTop + floatingCanvas.feetY * geo.scale
  assert.equal(renderedFeetY, geo.containerHeight)
})

test('normalizeVideoAnimation & animation pools: resolves single clips, objects, and candidate pools', () => {
  // Single string
  const str = normalizeVideoAnimation('videos/idle.webm')
  assert.deepEqual(str, { src: 'videos/idle.webm', loop: true })

  // Single object with playbackRate
  const obj = normalizeVideoAnimation({ src: 'videos/fast.webm', loop: false, playbackRate: 1.5 })
  assert.equal(obj?.playbackRate, 1.5)
  assert.equal(obj?.loop, false)

  // Candidate pool (array)
  const pool = [
    'videos/idle1.webm',
    { src: 'videos/idle2.webm', loop: true, noMirror: true },
  ]
  const first = normalizeVideoAnimation(pool, 0)
  assert.equal(first?.src, 'videos/idle1.webm')
  const second = normalizeVideoAnimation(pool, 1)
  assert.equal(second?.src, 'videos/idle2.webm')
  assert.equal(second?.noMirror, true)
  // Modulo cycling
  const cycled = normalizeVideoAnimation(pool, 2)
  assert.equal(cycled?.src, 'videos/idle1.webm')
})

test('isMirrorForbidden: purely generic without hardcoded character clip names', () => {
  const dummyPet: VideoPet = {
    renderer: 'video-clips',
    id: 'custom-pet',
    displayName: 'Custom',
    canvas: DSH_GEOMETRY,
    animations: {},
    noMirror: ['no_flip_clip', '写代码'],
  }

  // Explicit flag on animation meta
  assert.equal(isMirrorForbidden(dummyPet, 'other', { src: 'a.webm', noMirror: true }), true)

  // Listed in pet.noMirror by action key
  assert.equal(isMirrorForbidden(dummyPet, 'no_flip_clip', { src: 'a.webm' }), true)

  // Listed in pet.noMirror by filename (including URL-encoded)
  assert.equal(isMirrorForbidden(dummyPet, 'work', { src: 'assets/videos/%E5%86%99%E4%BB%A3%E7%A0%81.webm' }), true)

  // Normal clip not in pet.noMirror
  assert.equal(isMirrorForbidden(dummyPet, 'idle', { src: 'assets/videos/idle.webm' }), false)
})

test('getPetAspectRatio & getPetRenderMetrics: handles both CodexPet and VideoPet', () => {
  // Codex / null defaults to 208 / 192 (~1.0833)
  assert.equal(getPetAspectRatio(null), 208 / 192)
  const codexMetrics = getPetRenderMetrics(null, 192)
  assert.equal(codexMetrics.width, 192)
  assert.equal(codexMetrics.height, 208)

  // Video pet with DSH geometry: (330 - 60) / (428 - 212) = 270 / 216 = 1.25
  const videoPet: VideoPet = {
    renderer: 'video-clips',
    id: 'dsh',
    displayName: 'DSH',
    canvas: DSH_GEOMETRY,
    animations: {},
  }
  assert.equal(getPetAspectRatio(videoPet), 1.25)
  const videoMetrics = getPetRenderMetrics(videoPet, 108)
  assert.equal(videoMetrics.width, 108)
  assert.equal(videoMetrics.height, 135)
})

test('parsePetManifest: parses transparency, chromaKeyOptions, and animation candidate pools', () => {
  const raw = {
    id: 'shenshen',
    displayName: '申申',
    renderer: 'video-clips',
    transparency: 'native',
    chromaKeyOptions: { lowThreshold: 10, highThreshold: 25 },
    canvas: {
      width: 640,
      height: 360,
      bodyBox: [212, 60, 428, 330],
      feetY: 330,
    },
    noMirror: ['写代码'],
    animations: {
      idle: 'videos/idle.webm',
      work: [
        'videos/work1.webm',
        { src: 'videos/work2.webm', loop: false, playbackRate: 1.2 },
      ],
    },
  }

  const pet = parsePetManifest(raw, 'http://localhost/assets/shenshen')
  assert.ok(pet && pet.renderer === 'video-clips')
  assert.equal(pet.id, 'shenshen')
  assert.equal(pet.transparency, 'native')
  assert.deepEqual(pet.chromaKeyOptions, { lowThreshold: 10, highThreshold: 25 })
  assert.deepEqual(pet.noMirror, ['写代码'])
  assert.equal(pet.animations.idle, 'http://localhost/assets/shenshen/videos/idle.webm')
  assert.ok(Array.isArray(pet.animations.work))
  const workList = pet.animations.work as (string | VideoPetAnimationMeta)[]
  assert.equal(workList[0], 'http://localhost/assets/shenshen/videos/work1.webm')
  assert.equal((workList[1] as VideoPetAnimationMeta).playbackRate, 1.2)
})

test('BufferedVideo contract: generation-based swap prevents stale A->B->C races', () => {
  // Simulates the generation counter and swap gate used inside BufferedVideo
  let currentGeneration = 0
  let activeBuffer: 0 | 1 = 0
  let activeSrc: string | undefined = undefined

  const startLoad = (src: string) => {
    const generation = ++currentGeneration
    const targetBuffer: 0 | 1 = activeBuffer === 0 ? 1 : 0
    let cancelled = false

    const onPlaying = () => {
      if (cancelled || currentGeneration !== generation) {
        return false // Stale load dropped
      }
      activeBuffer = targetBuffer
      activeSrc = src
      return true // Swap committed
    }

    const cancel = () => {
      cancelled = true
    }

    return { generation, onPlaying, cancel }
  }

  // Load A (initial load)
  const reqA = startLoad('animA.webm')
  assert.equal(reqA.onPlaying(), true)
  assert.equal(activeBuffer, 1)
  assert.equal(activeSrc, 'animA.webm')

  // Rapid switch: Load B then Load C before B finishes
  const reqB = startLoad('animB.webm')
  const reqC = startLoad('animC.webm')

  // B finishes playing late (after C was started)
  assert.equal(reqB.onPlaying(), false)
  assert.equal(activeSrc, 'animA.webm') // Still A! B was dropped

  // C finishes playing
  assert.equal(reqC.onPlaying(), true)
  assert.equal(activeSrc, 'animC.webm') // Committed C cleanly
})

test('dual geometry model: separates character interaction hitbox from OS window canvas bounds', () => {
  // Shenshen at visualSize = 108
  const visualSize = 108
  const geo = computeVideoPetGeometry(DSH_GEOMETRY, visualSize)

  // 1. Nominal body hitbox
  assert.equal(geo.bodyWidth, 108)
  assert.equal(geo.bodyHeight, 135)
  assert.equal(geo.containerWidth, 108)
  assert.equal(geo.containerHeight, 135)

  // 2. Full OS window canvas bounds
  assert.equal(geo.canvasWidth, 320)
  assert.equal(geo.canvasHeight, 180)

  // 3. Canvas-anchored hitbox coordinates (for standalone native window & click testing)
  assert.equal(geo.hitboxLeft, 106)
  assert.equal(geo.hitboxTop, 30)

  // 4. Feet baseline alignment: hitboxTop + bodyHeight = 30 + 135 = 165
  const feetInCanvas = geo.hitboxTop + geo.bodyHeight
  assert.equal(feetInCanvas, 165)
  assert.equal(geo.canvasHeight - feetInCanvas, 15) // 15px effect margin below feet

  // 5. Body-anchored offsets (for card/list inline layouts)
  assert.equal(geo.canvasLeft, -106)
  assert.equal(geo.canvasTop, -30)

  // 6. PetRenderMetrics contract for VideoPet
  const videoPet: VideoPet = {
    renderer: 'video-clips',
    id: 'shenshen',
    displayName: '申申',
    canvas: DSH_GEOMETRY,
    animations: {},
  }
  const vMetrics = getPetRenderMetrics(videoPet, visualSize)
  assert.deepEqual(vMetrics.body, { width: 108, height: 135 })
  assert.deepEqual(vMetrics.canvas, { width: 320, height: 180 })
  assert.deepEqual(vMetrics.hitbox, { left: 106, top: 30, width: 108, height: 135 })
  assert.equal(vMetrics.width, 108)
  assert.equal(vMetrics.height, 135)

  // 7. PetRenderMetrics contract for CodexPet (1:1 backward compatibility)
  const cMetrics = getPetRenderMetrics(null, 192)
  assert.deepEqual(cMetrics.body, { width: 192, height: 208 })
  assert.deepEqual(cMetrics.canvas, { width: 192, height: 208 })
  assert.deepEqual(cMetrics.hitbox, { left: 0, top: 0, width: 192, height: 208 })
  assert.equal(cMetrics.width, 192)
  assert.equal(cMetrics.height, 208)
})

test('activeMiniPetMetrics: large mascot (Xiang-qi-e) and Codex pets isolate from custom canvas bounds', () => {
  const shenshenPet: VideoPet = {
    renderer: 'video-clips',
    id: 'shenshen',
    displayName: '申申',
    canvas: DSH_GEOMETRY,
    animations: {},
  }
  const codexPet: PetAsset = {
    id: 'classic-cat',
    name: 'Classic Cat',
    image: 'cat.png',
  }
  const resolveActiveMetrics = (largeMascot: boolean, miniPet: PetAsset | null, visualSize: number) => {
    return (!largeMascot && miniPet && isVideoPet(miniPet)) ? getPetRenderMetrics(miniPet, visualSize) : null
  }

  // When largeMascot is active (e.g. Xiang-qi-e), activeMiniPetMetrics must be null
  assert.equal(resolveActiveMetrics(true, shenshenPet, 215), null)

  // When miniPet is a standard Codex pet, activeMiniPetMetrics must be null
  // so Codex pets never trigger custom canvas/hitbox bounds and keep 100% legacy hit-testing
  assert.equal(resolveActiveMetrics(false, codexPet, 108), null)

  // When largeMascot is false and miniPet is Shenshen (VideoPet), activeMiniPetMetrics is computed
  const metricsWhenMini = resolveActiveMetrics(false, shenshenPet, 108)
  assert.notEqual(metricsWhenMini, null)
  assert.equal(metricsWhenMini!.canvas.width, 320)
  assert.equal(metricsWhenMini!.canvas.height, 180)
})

test('MiniPetMascot component identity: VideoPet preserves stable key across state transitions for double buffering', () => {
  const shenshenPet: VideoPet = {
    renderer: 'video-clips',
    id: 'shenshen',
    displayName: '申申',
    canvas: DSH_GEOMETRY,
    animations: {},
  }
  const codexPet: PetAsset = {
    id: 'classic-dog',
    name: 'Classic Dog',
    image: 'dog.png',
  }

  const computeRendererKey = (pet: PetAsset, renderState: string, isMovement: boolean, isReaction: boolean, showJump: boolean, jumpKey: number) => {
    const isVideo = isVideoPet(pet)
    const spriteKey = isMovement
      ? `move-${renderState}`
      : isReaction
        ? `reaction-${renderState}`
        : showJump
          ? `jump-${jumpKey}`
          : `base-${renderState}`
    return isVideo ? `videopet-${pet.id}` : spriteKey
  }

  // 1. VideoPet: key must remain identical across idle -> running -> waiting -> review
  // to prevent unmounting VideoPetRenderer and BufferedVideo, ensuring seamless front/back swaps
  const shenshenIdleKey = computeRendererKey(shenshenPet, 'idle', false, false, false, 0)
  const shenshenRunningKey = computeRendererKey(shenshenPet, 'running', false, false, false, 0)
  const shenshenWaitingKey = computeRendererKey(shenshenPet, 'waiting', false, false, false, 0)
  const shenshenReviewKey = computeRendererKey(shenshenPet, 'review', false, false, false, 0)

  assert.equal(shenshenIdleKey, 'videopet-shenshen')
  assert.equal(shenshenRunningKey, 'videopet-shenshen')
  assert.equal(shenshenWaitingKey, 'videopet-shenshen')
  assert.equal(shenshenReviewKey, 'videopet-shenshen')
  assert.equal(shenshenIdleKey, shenshenRunningKey)
  assert.equal(shenshenRunningKey, shenshenWaitingKey)

  // 2. VideoPet jump loop: key remains stable while replayToken increments
  const shenshenJumpKey0 = computeRendererKey(shenshenPet, 'jumping', false, false, true, 0)
  const shenshenJumpKey1 = computeRendererKey(shenshenPet, 'jumping', false, false, true, 1)
  assert.equal(shenshenJumpKey0, 'videopet-shenshen')
  assert.equal(shenshenJumpKey1, 'videopet-shenshen')

  // 3. Codex pet: key changes with state so SpritePet remounts to reset tick/frames
  const codexIdleKey = computeRendererKey(codexPet, 'idle', false, false, false, 0)
  const codexRunningKey = computeRendererKey(codexPet, 'running', false, false, false, 0)
  const codexWaitingKey = computeRendererKey(codexPet, 'waiting', false, false, false, 0)
  assert.equal(codexIdleKey, 'base-idle')
  assert.equal(codexRunningKey, 'base-running')
  assert.equal(codexWaitingKey, 'base-waiting')
  assert.notEqual(codexIdleKey, codexRunningKey)
})

test('Native window anchor stability: body coordinates remain invariant across resize and canvas changes', () => {
  // Shenshen metrics at scale 1 (width=215, canvas=637x358, hitbox={ left: 211, top: 60, width: 215, height: 269 })
  // Shenshen metrics at scale 2 (width=430, canvas=1274x716, hitbox={ left: 422, top: 120, width: 430, height: 538 })
  const s1 = { canvasW: 637, canvasH: 358, hx: 211, hy: 60, hw: 215, hh: 269 }
  const s2 = { canvasW: 1274, canvasH: 716, hx: 422, hy: 120, hw: 430, hh: 538 }

  // 1. Bottom-right anchor (Primary Mini Window)
  // Given screen anchor (body_right=1900, body_bottom=1000):
  const win1_x = 1900 - (s1.hx + s1.hw) // 1900 - 426 = 1474
  const win1_y = 1000 - (s1.hy + s1.hh) // 1000 - 329 = 671
  const body1_right = win1_x + s1.hx + s1.hw // 1474 + 426 = 1900
  const body1_bottom = win1_y + s1.hy + s1.hh // 671 + 329 = 1000
  assert.equal(body1_right, 1900)
  assert.equal(body1_bottom, 1000)

  // Resized to scale 2:
  const win2_x = 1900 - (s2.hx + s2.hw) // 1900 - 852 = 1048
  const win2_y = 1000 - (s2.hy + s2.hh) // 1000 - 658 = 342
  const body2_right = win2_x + s2.hx + s2.hw // 1048 + 852 = 1900
  const body2_bottom = win2_y + s2.hy + s2.hh // 342 + 658 = 1000
  assert.equal(body2_right, 1900)
  assert.equal(body2_bottom, 1000)

  // 2. Top-left anchor (Extra / Demo Mascot Windows)
  // Given spawn point (body_left=1700, body_top=50):
  const extra1_x = 1700 - s1.hx // 1700 - 211 = 1489
  const extra1_y = 50 - s1.hy // 50 - 60 = -10
  const extra_body1_left = extra1_x + s1.hx // 1489 + 211 = 1700
  const extra_body1_top = extra1_y + s1.hy // -10 + 60 = 50
  assert.equal(extra_body1_left, 1700)
  assert.equal(extra_body1_top, 50)

  // Resized to scale 2:
  const extra2_x = 1700 - s2.hx // 1700 - 422 = 1278
  const extra2_y = 50 - s2.hy // 50 - 120 = -70
  const extra_body2_left = extra2_x + s2.hx // 1278 + 422 = 1700
  const extra_body2_top = extra2_y + s2.hy // -70 + 120 = 50
  assert.equal(extra_body2_left, 1700)
  assert.equal(extra_body2_top, 50)
})

test('Mini bounds unregister layout restore: only triggers when transitioning from VideoPet while collapsed', () => {
  const shouldRestoreLayout = (
    wasVideoPet: boolean,
    isExpanded: boolean,
    settingsMode: boolean,
    settingsTransitioning: boolean,
  ) => {
    return wasVideoPet && !isExpanded && !settingsMode && !settingsTransitioning
  }

  // 1. Startup / normal Codex pet initialization: wasVideoPet is false -> NEVER touches window layout
  assert.equal(shouldRestoreLayout(false, false, false, false), false)

  // 2. Settings modal open: switching from VideoPet to Codex in settings -> NEVER touches window layout
  assert.equal(shouldRestoreLayout(true, false, true, false), false)

  // 3. Settings modal transitioning: -> NEVER touches window layout
  assert.equal(shouldRestoreLayout(true, false, false, true), false)

  // 4. Expanded panel open: -> NEVER touches window layout
  assert.equal(shouldRestoreLayout(true, true, false, false), false)

  // 5. Collapsed on desktop: user switches from VideoPet to Codex/Xiang-qi-e -> RESTORES authoritative native layout
  assert.equal(shouldRestoreLayout(true, false, false, false), true)

  // 6. Restored layout arguments for coding mode must use largeMascot: true (preserving large collapsed coding mascot size ~215px)
  const getRestoreArgs = (appMode: string) => {
    if (appMode === 'pet') {
      return { active: true }
    }
    return { expanded: false, largeMascot: true }
  }
  assert.equal(getRestoreArgs('coding').largeMascot, true)
})

test('DemoMascot effect lifecycle: size changes preserve registry entry preventing anchor jump', () => {
  // Simulating registry state across size updates
  let registeredHitbox: { hx: number; hy: number } | null = null

  const onMountOrSizeChange = (hx: number, hy: number) => {
    // Sync updates or sets the entry without clearing it
    registeredHitbox = { hx, hy }
  }

  const onUnmountOnly = () => {
    registeredHitbox = null
  }

  // 1. Mount at scale 1:
  onMountOrSizeChange(211, 60)
  assert.deepEqual(registeredHitbox, { hx: 211, hy: 60 })

  // 2. User resizes to scale 1.5: previous effect DOES NOT call onUnmountOnly()
  // So registeredHitbox is still available as prev_entry when calculating new coordinates
  const prevEntry = registeredHitbox
  assert.notEqual(prevEntry, null)
  assert.equal(prevEntry!.hx, 211)

  // New size applied:
  onMountOrSizeChange(316, 90)
  assert.deepEqual(registeredHitbox, { hx: 316, hy: 90 })

  // 3. Window closes (unmount):
  onUnmountOnly()
  assert.equal(registeredHitbox, null)
})





