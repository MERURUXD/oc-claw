import type { TFunction } from 'i18next'
import type { SessionActivity } from './types'

/**
 * Formats a normalized SessionActivity into a localized subtitle string for MascotBubble.
 */
export function formatActivity(activity: SessionActivity, t: TFunction): string {
  const isCompleted = activity.status === 'completed'

  switch (activity.kind) {
    case 'reasoning':
      return activity.summary || ''

    case 'read':
      if (isCompleted) {
        return activity.target
          ? t('mini.activityRead', { target: activity.target, defaultValue: `Read ${activity.target}` })
          : t('mini.activityReadFiles', { defaultValue: 'Read files' })
      }
      return activity.target
        ? t('mini.activityReading', { target: activity.target, defaultValue: `Reading ${activity.target}` })
        : t('mini.activityReadingFiles', { defaultValue: 'Reading files' })

    case 'list':
      if (isCompleted) {
        return t('mini.activityListed', { defaultValue: 'Listed files' })
      }
      return t('mini.activityListing', { defaultValue: 'Listing files' })

    case 'search':
      if (isCompleted) {
        return activity.query
          ? t('mini.activitySearched', { query: activity.query, defaultValue: `Searched "${activity.query}"` })
          : t('mini.activitySearchedFiles', { defaultValue: 'Searched files' })
      }
      return activity.query
        ? t('mini.activitySearching', { query: activity.query, defaultValue: `Searching "${activity.query}"` })
        : t('mini.activitySearchingFiles', { defaultValue: 'Searching files' })

    case 'edit':
      if (isCompleted) {
        if (activity.target) {
          return t('mini.activityEdited', { target: activity.target, defaultValue: `Edited ${activity.target}` })
        }
        if (activity.count != null && activity.count > 1) {
          return t('mini.activityEditedCount', { count: activity.count, defaultValue: `Edited ${activity.count} files` })
        }
        return t('mini.activityEditedGeneric', { defaultValue: 'Edited files' })
      }
      if (activity.target) {
        return t('mini.activityEditing', { target: activity.target, defaultValue: `Editing ${activity.target}` })
      }
      if (activity.count != null && activity.count > 1) {
        return t('mini.activityEditingCount', { count: activity.count, defaultValue: `Editing ${activity.count} files` })
      }
      return t('mini.activityEditingGeneric', { defaultValue: 'Editing files' })

    case 'command':
      if (isCompleted) {
        return t('mini.activityRanCommand', { defaultValue: 'Ran command' })
      }
      return t('mini.activityRunningCommand', { defaultValue: 'Running command' })

    case 'tool':
      if (isCompleted) {
        return t('mini.activityCalledTool', {
          toolName: activity.toolName || 'tool',
          defaultValue: `Called ${activity.toolName || 'tool'}`,
        })
      }
      return t('mini.activityCallingTool', {
        toolName: activity.toolName || 'tool',
        defaultValue: `Calling ${activity.toolName || 'tool'}`,
      })

    case 'web':
      if (isCompleted) {
        return activity.query
          ? t('mini.activitySearchedWeb', { query: activity.query, defaultValue: `Searched web for "${activity.query}"` })
          : t('mini.activitySearchedWebGeneric', { defaultValue: 'Searched web' })
      }
      return activity.query
        ? t('mini.activitySearchingWeb', { query: activity.query, defaultValue: `Searching web for "${activity.query}"` })
        : t('mini.activitySearchingWebGeneric', { defaultValue: 'Searching web' })

    case 'subagent':
      return t('mini.activityDelegating', { defaultValue: 'Delegating task' })

    case 'generic':
    default:
      return t('mini.working', { defaultValue: 'working...' })
  }
}
