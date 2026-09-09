import { useCallback, useEffect, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsTab as SettingsTabBase } from './SettingsTabBase'
import { DebugSettingsSection } from './DebugSettingsSection'
import { getStore } from '../lib/store'
import type { DebugInjectPreset } from '../lib/debugInject'

type BaseSettingsTabProps = ComponentProps<typeof SettingsTabBase>

type SettingsTabProps = BaseSettingsTabProps & {
  onDebugInjectPreset?: (preset: DebugInjectPreset) => void
  onClearDebugInject?: () => void
  debugInjectCount?: number
}

const STORE_KEY = 'developer_mode'

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${checked ? 'bg-blue-500' : 'bg-white/10'}`}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${checked ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  )
}

/**
 * Thin composition wrapper: SettingsTabBase + optional Debug QA section.
 * Debug controls are gated behind persisted developer mode.
 */
export function SettingsTab({
  onDebugInjectPreset,
  onClearDebugInject,
  debugInjectCount = 0,
  ...props
}: SettingsTabProps) {
  const { t } = useTranslation()
  const [developerMode, setDeveloperMode] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const store = await getStore()
        const saved = await store.get(STORE_KEY)
        setDeveloperMode(saved === true)
      } catch {
        setDeveloperMode(false)
      } finally {
        setLoaded(true)
      }
    })()
  }, [])

  const toggleDeveloperMode = useCallback(async (next: boolean) => {
    setDeveloperMode(next)
    try {
      const store = await getStore()
      await store.set(STORE_KEY, next)
      await store.save()
    } catch {
      // ignore persistence errors — UI state still updates
    }
    if (!next) {
      onClearDebugInject?.()
    }
  }, [onClearDebugInject])

  return (
    <>
      <SettingsTabBase {...props} />
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium text-white">{t('settings.developer', 'Developer')}</h2>
        <div className="bg-[#0f0f0f] border border-white/5 rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between p-4">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-white/90">{t('settings.developerMode', 'Developer Mode')}</span>
              <span className="text-xs text-white/40">
                {t('settings.developerModeDesc', 'Show debug settings such as test session inject')}
              </span>
            </div>
            <Toggle checked={developerMode} onChange={(v) => { void toggleDeveloperMode(v) }} />
          </div>
        </div>
      </section>
      {loaded && developerMode && (
        <DebugSettingsSection
          onDebugInjectPreset={onDebugInjectPreset}
          onClearDebugInject={onClearDebugInject}
          debugInjectCount={debugInjectCount}
        />
      )}
    </>
  )
}
