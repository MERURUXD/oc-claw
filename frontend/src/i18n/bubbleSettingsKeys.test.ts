import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Static guard for the bubble settings copy.
 *
 * `t('settings.key', '中文默认文案')` never fails on a bad key: when the key is
 * missing (or spelled differently between the component and the JSON), i18next
 * hands back the inline default — so a drifted key silently renders Chinese in
 * every language. `bubbleStatusMotionMatrixModeDesc` drifted exactly that way, so
 * the `settings.bubble*` keys are checked against the shipped locales instead of
 * trusted.
 */
const SRC_DIR = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '')
const LOCALE_DIR = fileURLToPath(new URL('./locales/', import.meta.url)).replace(/[\\/]$/, '')
const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'ja', 'ko', 'zh'] as const

const BUBBLE_KEY_PATTERN = /['"](settings\.bubble[A-Za-z0-9]*)['"]/g
const STATUS_MOTION_KEY_PATTERN = /^bubbleStatusMotion[A-Za-z0-9]*$/

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) return collectSourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [full] : []
  })
}

function readSettingsBlock(locale: string): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(`${LOCALE_DIR}/${locale}.json`, 'utf8')) as {
    settings?: Record<string, unknown>
  }
  return doc.settings ?? {}
}

// Every `settings.bubble*` key referenced anywhere in the app source.
const referencedKeys = new Set<string>()
for (const file of collectSourceFiles(SRC_DIR)) {
  for (const match of readFileSync(file, 'utf8').matchAll(BUBBLE_KEY_PATTERN)) {
    referencedKeys.add(match[1])
  }
}

const referencedStatusMotionKeys = [...referencedKeys]
  .map((key) => key.split('.')[1])
  .filter((key) => STATUS_MOTION_KEY_PATTERN.test(key))
  .sort()

test('bubble settings: a missing pattern match must not silently pass the guard', () => {
  assert.ok(
    referencedKeys.size >= 12,
    `the source scan must find the bubble settings keys, found ${referencedKeys.size}`
  )
  assert.deepEqual(referencedStatusMotionKeys, [
    'bubbleStatusMotion',
    'bubbleStatusMotionDesc',
    'bubbleStatusMotionMatrix',
    'bubbleStatusMotionMatrixModeDesc',
    'bubbleStatusMotionOrbs',
    'bubbleStatusMotionOrbsDesc',
  ])
})

test('bubble settings: every referenced key resolves in every locale', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const settings = readSettingsBlock(locale)
    for (const key of referencedKeys) {
      const value = settings[key.split('.')[1]]
      assert.equal(
        typeof value,
        'string',
        `${key} is read by the app but missing from ${locale}.json — it would render the inline Chinese default`
      )
      assert.ok((value as string).trim().length > 0, `${key} must not be empty in ${locale}.json`)
    }
  }
})

test('bubble settings: the status-animation family is keyed identically on both sides', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const inLocale = Object.keys(readSettingsBlock(locale))
      .filter((key) => STATUS_MOTION_KEY_PATTERN.test(key))
      .sort()
    assert.deepEqual(
      inLocale,
      referencedStatusMotionKeys,
      `${locale}.json must carry exactly the status-motion keys the components read — a rename on one side only is the drift that hid the Chinese fallback`
    )
  }
})
