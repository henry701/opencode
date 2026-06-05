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
