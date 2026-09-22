import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeVideoPetGeometry,
  mapSemanticStateToVideoCandidates,
  DSH_GEOMETRY,
  type VideoPetCanvasGeometry,
} from './videoPet.ts'

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
