import { patchFiles, type ApplyPatchFile } from "./apply-patch-file"

export function applyPatchToolFiles(metadata: unknown): ApplyPatchFile[] {
  return patchFiles(metadata)
}
