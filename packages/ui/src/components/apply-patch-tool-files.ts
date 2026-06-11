import { patchFiles } from "./apply-patch-file"

export function applyPatchToolFiles(metadata: unknown) {
  return patchFiles(metadata)
}
