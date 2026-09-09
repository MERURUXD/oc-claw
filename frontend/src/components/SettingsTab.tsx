import type { ComponentProps } from 'react'
import { SettingsTab as SettingsTabBase } from './SettingsTabBase'
import { DebugSettingsSection } from './DebugSettingsSection'
import type { DebugInjectPreset } from '../lib/debugInject'

type BaseSettingsTabProps = ComponentProps<typeof SettingsTabBase>

type SettingsTabProps = BaseSettingsTabProps & {
  onDebugInjectPreset?: (preset: DebugInjectPreset) => void
  onClearDebugInject?: () => void
  debugInjectCount?: number
}

/**
 * Thin composition wrapper kept separate from SettingsTabBase so the debug QA
 * controls can coexist with the About/build-info changes already on main.
 */
export function SettingsTab({
  onDebugInjectPreset,
  onClearDebugInject,
  debugInjectCount = 0,
  ...props
}: SettingsTabProps) {
  return (
    <>
      <SettingsTabBase {...props} />
      <DebugSettingsSection
        onDebugInjectPreset={onDebugInjectPreset}
        onClearDebugInject={onClearDebugInject}
        debugInjectCount={debugInjectCount}
      />
    </>
  )
}
