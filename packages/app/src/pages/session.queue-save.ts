export function applyQueueSaveSuccess(input: {
  sessionID: string
  queueID?: string
  clearFailed: () => void
  clearPaused: () => void
  clearEdit: () => void
  stopEditing: () => void
  resumeDrain: (sessionID: string) => void
}) {
  input.clearFailed()
  input.clearPaused()
  if (!input.queueID) return
  input.clearEdit()
  input.stopEditing()
  input.resumeDrain(input.sessionID)
}
