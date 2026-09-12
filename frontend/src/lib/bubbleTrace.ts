import { invoke } from '@tauri-apps/api/core'

export interface BubbleTraceMeta {
  transitionId?: number | null
  details?: Record<string, string | number | boolean | null | undefined>
}

/**
 * Sanitize diagnostic detail records into strings, filtering null and undefined.
 */
export function sanitizeTraceDetails(
  details?: Record<string, string | number | boolean | null | undefined>
): Record<string, string> | null {
  if (!details) return null
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined && value !== null) {
      sanitized[key] = String(value)
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null
}

/**
 * Send a bubble trace event to the Rust/Win32 diagnostic logger.
 * Safe to call at any time; will never throw or interrupt UI logic.
 */
export function traceBubbleEvent(event: string, meta?: BubbleTraceMeta): void {
  const details = sanitizeTraceDetails(meta?.details)

  invoke('trace_bubble_event', {
    event,
    transitionId: meta?.transitionId ?? null,
    details,
  }).catch(() => {
    // Suppress any IPC failure during tracing
  })
}

/**
 * Get whether bubble runtime tracing is currently enabled.
 */
export async function getBubbleRuntimeTrace(): Promise<boolean> {
  try {
    return await invoke<boolean>('get_bubble_runtime_trace')
  } catch {
    return false
  }
}

/**
 * Set whether bubble runtime tracing is currently enabled.
 */
export async function setBubbleRuntimeTrace(enabled: boolean): Promise<boolean> {
  try {
    return await invoke<boolean>('set_bubble_runtime_trace', { enabled })
  } catch {
    return false
  }
}
