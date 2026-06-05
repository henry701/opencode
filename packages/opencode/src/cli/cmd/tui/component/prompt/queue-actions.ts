export function queueMutationError(input: { result: unknown; fallback: unknown }) {
  if (!input.result) return input.fallback
  if (typeof input.result !== "object") return undefined
  if (!("error" in input.result)) return undefined
  return input.result.error || undefined
}
