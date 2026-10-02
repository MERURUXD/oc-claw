interface PermissionSubmission {
  deliver: () => Promise<unknown>
  isCurrent: () => boolean
  setBusy: (busy: boolean) => void
  setError: (error: string) => void
  onDelivered: () => void
}

/** The command promise resolves only after hook socket write + flush. */
export async function submitClaudePermission(submission: PermissionSubmission): Promise<void> {
  submission.setBusy(true)
  submission.setError('')
  try {
    await submission.deliver()
    if (submission.isCurrent()) submission.onDelivered()
  } catch (error) {
    submission.setError(String(error))
  } finally {
    submission.setBusy(false)
  }
}
