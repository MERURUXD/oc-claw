import { useEffect, useState } from 'react'
import { DEBUG_INJECT_PRESETS, type DebugInjectPreset } from '../lib/debugInject'
import { getBubbleRuntimeTrace, setBubbleRuntimeTrace } from '../lib/bubbleTrace'

export function DebugSettingsSection({
  onDebugInjectPreset,
  onClearDebugInject,
  debugInjectCount = 0,
}: {
  onDebugInjectPreset?: (preset: DebugInjectPreset) => void
  onClearDebugInject?: () => void
  debugInjectCount?: number
}) {
  const isZh = typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
  const [bubbleTraceEnabled, setBubbleTraceEnabled] = useState(false)

  useEffect(() => {
    getBubbleRuntimeTrace().then(setBubbleTraceEnabled)
  }, [])

  const presetLabel = (preset: DebugInjectPreset) => {
    if (!isZh) {
      const item = DEBUG_INJECT_PRESETS.find((p) => p.id === preset)
      return item?.fallback || preset
    }
    switch (preset) {
      case 'processing-generic': return '注入处理中（通用）'
      case 'processing-command': return '注入处理中（命令）'
      case 'waiting-approval': return '注入等待（批准）'
      case 'waiting-user-input': return '注入等待（用户输入）'
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-medium text-white">{isZh ? '调试' : 'Debug'}</h2>
      <div className="bg-[#0f0f0f] border border-white/5 rounded-2xl overflow-hidden p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between pb-1">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-white/90">
              {isZh ? '气泡运行追踪 (Bubble Trace)' : 'Bubble Runtime Trace'}
            </span>
            <span className="text-xs text-white/40">
              {isZh
                ? '记录气泡生命周期与 Win32 原生窗口事件到 run-*.log (OC_BUBBLE_TRACE=1)'
                : 'Log bubble lifecycle & Win32 native window mutations to run-*.log (OC_BUBBLE_TRACE=1)'}
            </span>
          </div>
          <button
            type="button"
            onClick={async () => {
              const next = !bubbleTraceEnabled
              const actual = await setBubbleRuntimeTrace(next)
              setBubbleTraceEnabled(actual)
            }}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${bubbleTraceEnabled ? 'bg-blue-500' : 'bg-white/10'}`}
            role="switch"
            aria-checked={bubbleTraceEnabled}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${bubbleTraceEnabled ? 'translate-x-5' : 'translate-x-0'}`}
            />
          </button>
        </div>

        <div className="border-t border-white/5 pt-3 flex flex-col gap-1">
          <span className="text-sm font-medium text-white/90">{isZh ? '测试消息注入' : 'Test message inject'}</span>
          <span className="text-xs text-white/40">
            {isZh
              ? '仅在内存中注入假的 coding session；不访问网络、不启动真实 agent、不写历史。紧凑/详细样式沿用上方气泡设置。'
              : 'Inject fake coding sessions into memory only. No network, no real agent, no history. Use the bubble style above for compact/detailed.'}
          </span>
          {debugInjectCount > 0 && (
            <span className="text-xs text-amber-400">
              {isZh ? `${debugInjectCount} 个调试 session 正在生效` : `${debugInjectCount} debug session(s) active`}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          {DEBUG_INJECT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onDebugInjectPreset?.(preset.id)}
              disabled={!onDebugInjectPreset}
              className="w-full text-left px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-white/80 transition-colors disabled:opacity-40"
            >
              {presetLabel(preset.id)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onClearDebugInject?.()}
          disabled={!onClearDebugInject || debugInjectCount === 0}
          className="w-full py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
        >
          {isZh ? '清除调试注入' : 'Clear debug inject'}
        </button>
      </div>
    </section>
  )
}
