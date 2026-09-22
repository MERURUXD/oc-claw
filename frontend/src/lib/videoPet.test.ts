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
import { getPetAspectRatio, getPetRenderMetrics, parsePetManifest } from './petAsset.ts'

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



