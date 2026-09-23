import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePetManifest,
  isCodexPet,
  isVideoPet,
} from './petAsset.ts'
import {
  resolveVideoAnimation,
  isMirrorForbidden,
  DSH_GEOMETRY,
  type VideoPet,
} from './videoPet.ts'

test('parsePetManifest: legacy manifest without renderer defaults to CodexPet', () => {
  const raw = {
    id: 'doro',
    displayName: 'Doro',
    description: 'A cute creature',
    spritesheetPath: 'spritesheet.webp',
  }
  const pet = parsePetManifest(raw, '/assets/builtin/doro')
  assert.ok(pet)
  assert.equal(isCodexPet(pet), true)
  assert.equal(isVideoPet(pet), false)
  if (isCodexPet(pet)) {
    assert.equal(pet.id, 'doro')
    assert.equal(pet.displayName, 'Doro')
    assert.equal(pet.renderer, 'sprite-atlas')
    assert.equal(pet.spritesheetUrl, '/assets/builtin/doro/spritesheet.webp')
  }
})

test('parsePetManifest: explicit sprite-atlas renderer works cleanly', () => {
  const raw = {
    id: 'phoebe',
    displayName: 'Phoebe',
    renderer: 'sprite-atlas',
    spritesheetPath: 'custom_sheet.webp',
  }
  const pet = parsePetManifest(raw, 'https://example.com/pets/phoebe')
  assert.ok(pet)
  assert.equal(isCodexPet(pet), true)
  if (isCodexPet(pet)) {
    assert.equal(pet.spritesheetUrl, 'https://example.com/pets/phoebe/custom_sheet.webp')
  }
})

test('parsePetManifest: video-clips manifest parses canvas, bodyBox, and animations', () => {
  const raw = {
    id: 'shenshen',
    displayName: '申申',
    renderer: 'video-clips',
    canvas: {
      width: 640,
      height: 360,
      bodyBox: [212, 60, 428, 330],
      feetY: 330,
    },
    fps: 24,
    noMirror: ['写代码', '吃Token'],
    animations: {
      idle: 'videos/待机呼吸休闲.webm',
      work: {
        src: 'videos/工作状态-忙碌点按.webm',
        loop: true,
      },
      code: {
        src: 'videos/写代码.webm',
        loop: true,
        noMirror: true,
      },
    },
  }

  const pet = parsePetManifest(raw, '/assets/builtin/shenshen')
  assert.ok(pet)
  assert.equal(isVideoPet(pet), true)
  assert.equal(isCodexPet(pet), false)

  if (isVideoPet(pet)) {
    assert.equal(pet.id, 'shenshen')
    assert.equal(pet.displayName, '申申')
    assert.equal(pet.renderer, 'video-clips')
    assert.equal(pet.fps, 24)
    assert.deepEqual(pet.canvas.bodyBox, [212, 60, 428, 330])
    assert.equal(pet.canvas.feetY, 330)
    assert.equal(pet.animations['idle'], '/assets/builtin/shenshen/videos/待机呼吸休闲.webm')

    const workAnim = pet.animations['work']
    assert.ok(typeof workAnim === 'object')
    assert.equal(workAnim.src, '/assets/builtin/shenshen/videos/工作状态-忙碌点按.webm')
    assert.equal(workAnim.loop, true)

    const codeAnim = pet.animations['code']
    assert.ok(typeof codeAnim === 'object')
    assert.equal(codeAnim.noMirror, true)
  }
})

test('parsePetManifest: invalid or malformed manifests degrade gracefully', () => {
  assert.equal(parsePetManifest(null, '/assets/builtin/test'), null)
  assert.equal(parsePetManifest('not an object', '/assets/builtin/test'), null)

  const emptyVideo = parsePetManifest({ renderer: 'video-clips' }, '/assets/builtin/fallback-id')
  assert.ok(emptyVideo)
  assert.equal(isVideoPet(emptyVideo), true)
  if (isVideoPet(emptyVideo)) {
    assert.equal(emptyVideo.id, 'fallback-id')
    assert.equal(emptyVideo.canvas.width, 640)
    assert.equal(emptyVideo.canvas.height, 360)
    assert.deepEqual(emptyVideo.canvas.bodyBox, [0, 0, 640, 360])
  }
})

test('videoPet helpers: resolveVideoAnimation and fallback logic', () => {
  const pet: VideoPet = {
    renderer: 'video-clips',
    id: 'test',
    displayName: 'Test',
    canvas: DSH_GEOMETRY,
    animations: {
      idle: '/pets/idle.webm',
      run: { src: '/pets/run.webm', loop: true },
    },
    noMirror: ['special_text'],
  }

  const direct = resolveVideoAnimation(pet, 'run')
  assert.ok(direct)
  assert.equal(direct.key, 'run')
  assert.equal(direct.meta.src, '/pets/run.webm')

  const fallbackIdle = resolveVideoAnimation(pet, 'unknown_state')
  assert.ok(fallbackIdle)
  assert.equal(fallbackIdle.key, 'idle')
  assert.equal(fallbackIdle.meta.src, '/pets/idle.webm')
})

test('videoPet helpers: isMirrorForbidden respects flags and canonical text clips', () => {
  const pet: VideoPet = {
    renderer: 'video-clips',
    id: 'shenshen',
    displayName: '申申',
    canvas: DSH_GEOMETRY,
    animations: {
      idle: '/pets/idle.webm',
      code: { src: '/pets/写代码.webm', loop: true },
      wave: { src: '/pets/wave.webm', loop: false, noMirror: true },
    },
    noMirror: ['custom_no_flip', '写代码'],
  }

  // Animation marked with noMirror: true
  assert.equal(isMirrorForbidden(pet, 'wave', { src: '/pets/wave.webm', noMirror: true }), true)

  // In pet's noMirror array
  assert.equal(isMirrorForbidden(pet, 'custom_no_flip'), true)

  // Canonical DSH clip with text ("写代码")
  assert.equal(isMirrorForbidden(pet, 'code', { src: '/pets/写代码.webm' }), true)

  // Ordinary clip without text
  assert.equal(isMirrorForbidden(pet, 'idle', { src: '/pets/idle.webm' }), false)
})

test('builtin shenshen bundle: valid manifest and all 5 representative video files exist', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const manifestPath = path.resolve(import.meta.dirname, '../../public/assets/builtin/shenshen/pet.json')
  assert.ok(fs.existsSync(manifestPath), 'shenshen/pet.json must exist')
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const pet = parsePetManifest(raw, '/assets/builtin/shenshen')
  assert.ok(pet)
  assert.equal(isVideoPet(pet), true)
  if (isVideoPet(pet)) {
    assert.equal(pet.renderer, 'video-clips')
    assert.equal(pet.id, 'shenshen')
    assert.deepEqual(pet.canvas.bodyBox, [212, 60, 428, 330])
    assert.equal(pet.canvas.feetY, 330)

    // Check each animation video file exists on disk
    for (const [key, anim] of Object.entries(pet.animations)) {
      const animMeta = typeof anim === 'string' ? { src: anim } : anim
      const relPath = animMeta.src.replace(/^\/assets\/builtin\/shenshen\//, '')
      const fullPath = path.resolve(import.meta.dirname, '../../public/assets/builtin/shenshen', relPath)
      assert.ok(fs.existsSync(fullPath), `Video file for animation '${key}' must exist at ${fullPath}`)
      const stat = fs.statSync(fullPath)
      assert.ok(stat.size > 10000, `Video file ${relPath} should have non-trivial size`)
    }
  }

  // Verify shenshen is included in pets-manifest.json
  const builtinManifestPath = path.resolve(import.meta.dirname, '../../public/assets/builtin/pets-manifest.json')
  const builtinManifest = JSON.parse(fs.readFileSync(builtinManifestPath, 'utf8'))
  assert.ok(builtinManifest.pets.includes('shenshen'), 'pets-manifest.json must include shenshen')
})

