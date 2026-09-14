import test from 'node:test'
import assert from 'node:assert/strict'
import { BUBBLE_STATUS_TRANSLATIONS } from './bubbleStatusTranslations.ts'

const REQUIRED_KEYS = [
  'statusNeedsAnswer',
  'waitingApproval',
  'waitingFileApproval',
  'statusRunning',
  'statusWorking',
  'statusWaitingSubagents',
  'processingFallback',
] as const

test('bubble status translations exist for every supported locale', () => {
  for (const [locale, translations] of Object.entries(BUBBLE_STATUS_TRANSLATIONS)) {
    for (const key of REQUIRED_KEYS) {
      assert.equal(
        typeof translations[key],
        'string',
        `${locale}.${key} must be a string`
      )
      assert.ok(translations[key].trim().length > 0, `${locale}.${key} must not be empty`)
    }
  }

  assert.deepEqual(
    Object.keys(BUBBLE_STATUS_TRANSLATIONS).sort(),
    ['en', 'es', 'fr', 'ja', 'ko', 'zh']
  )
})
