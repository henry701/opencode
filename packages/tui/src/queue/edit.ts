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

export function queueSendNowTransitionPlan(input: {
  items: Array<{ id: string; text?: string }>
  messageID: string
  editingID: string | undefined
}) {
  if (input.editingID !== input.messageID) {
    return {
      type: "keep" as const,
      releaseControlsBeforeSendSettles: true,
    }
  }

  const index = input.items.findIndex((item) => item.id === input.messageID)
  if (index < 0) {
    return {
      type: "exit" as const,
      releaseControlsBeforeSendSettles: true,
    }
  }

  const editID = input.items[index + 1]?.id ?? input.items[index - 1]?.id
  if (editID) {
    return {
      type: "advance" as const,
      editID,
      releaseControlsBeforeSendSettles: true,
    }
  }

  return {
    type: "exit" as const,
    releaseControlsBeforeSendSettles: true,
  }
}

export function queueSendNowEmptyEditPlan(input: { items: Array<{ id: string; text?: string }>; messageID: string }) {
  const index = input.items.findIndex((item) => item.id === input.messageID)
  if (index < 0) return { type: "missing" as const }

  const editID = input.items[index + 1]?.id
  if (editID) {
    return {
      type: "advance" as const,
      editID,
    }
  }

  return {
    type: "exit" as const,
  }
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
