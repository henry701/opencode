export function queueEditSwitchPlan(input: { currentID: string | undefined; targetID: string }) {
  return {
    editID: input.targetID,
    saveCurrent: false,
  }
}

export function queueEditCommitPlan(input: { text: string }) {
  if (!input.text.trim()) return { type: "remove" as const }
  return { type: "save" as const }
}

export function queueSendNowDispatch(input: {
  send: () => Promise<void>
  onError: (error: unknown) => void | Promise<void>
  releaseControls: () => void
}) {
  const sendTask = input.send().catch(input.onError)
  input.releaseControls()
  return sendTask
}
