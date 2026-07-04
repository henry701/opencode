import { parsePatch } from "diff"
import { normalize, type ViewDiff } from "./session-diff"

type Kind = "add" | "update" | "delete" | "move"

type Raw = {
  filePath?: string
  relativePath?: string
  type?: Kind
  patch?: string
  diff?: string
  before?: string
  after?: string
  additions?: number
  deletions?: number
  movePath?: string
}

export type ApplyPatchFile = {
  filePath: string
  relativePath: string
  type: Kind
  additions: number
  deletions: number
  movePath?: string
  view: ViewDiff
}

function kind(value: unknown) {
  if (value === "add" || value === "update" || value === "delete" || value === "move") return value
}

function status(type: Kind): "added" | "deleted" | "modified" {
  if (type === "add") return "added"
  if (type === "delete") return "deleted"
  return "modified"
}

export function patchFile(raw: unknown): ApplyPatchFile | undefined {
  if (!raw || typeof raw !== "object") return

  const value = raw as Raw
  const type = kind(value.type)
  const filePath = typeof value.filePath === "string" ? value.filePath : undefined
  const relativePath = typeof value.relativePath === "string" ? value.relativePath : filePath
  const patch = typeof value.patch === "string" ? value.patch : typeof value.diff === "string" ? value.diff : undefined
  const before = typeof value.before === "string" ? value.before : undefined
  const after = typeof value.after === "string" ? value.after : undefined

  if (!type || !filePath || !relativePath) return
  if (!patch && before === undefined && after === undefined) return

  const additions = typeof value.additions === "number" ? value.additions : 0
  const deletions = typeof value.deletions === "number" ? value.deletions : 0
  const movePath = typeof value.movePath === "string" ? value.movePath : undefined

  return {
    filePath,
    relativePath,
    type,
    additions,
    deletions,
    movePath,
    view: normalize({
      file: relativePath,
      patch,
      before,
      after,
      additions,
      deletions,
      status: status(type),
    }),
  }
}

export function patchFiles(raw: unknown) {
  const explicit = explicitPatchFiles(raw)
  if (explicit.length > 0) return explicit

  const diff = metadataDiff(raw)
  if (!diff) return []

  return patchFilesFromDiff(diff)
}

function explicitPatchFiles(raw: unknown) {
  const single = patchFile(raw)
  if (single) return [single]

  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && "files" in raw
      ? fileValues((raw as { files?: unknown }).files)
      : fileValues(raw)

  return list.map(patchFile).filter((file): file is ApplyPatchFile => !!file)
}

function fileValues(raw: unknown) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === "object") return Object.values(raw as Record<string, unknown>)
  return []
}

function metadataDiff(raw: unknown) {
  if (!raw || typeof raw !== "object") return
  const value = raw as { diff?: unknown }
  return typeof value.diff === "string" ? value.diff : undefined
}

function patchFilesFromDiff(diff: string) {
  try {
    return parsePatch(diff)
      .map((patch) => {
        const filePath = parsedFilePath(patch.oldFileName, patch.newFileName)
        if (!filePath) return

        return patchFile({
          filePath,
          relativePath: relativePatchPath(filePath),
          type: parsedKind(patch.oldFileName, patch.newFileName),
          patch: unifiedPatch(filePath, patch),
          additions: patch.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.startsWith("+")).length,
          deletions: patch.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.startsWith("-")).length,
        })
      })
      .filter((file): file is ApplyPatchFile => !!file)
  } catch {
    return []
  }
}

function parsedFilePath(oldFileName: string | undefined, newFileName: string | undefined) {
  const filePath = newFileName && newFileName !== "/dev/null" ? newFileName : oldFileName
  if (!filePath || filePath === "/dev/null") return
  return filePath
}

function parsedKind(oldFileName: string | undefined, newFileName: string | undefined): Kind {
  if (oldFileName === "/dev/null") return "add"
  if (newFileName === "/dev/null") return "delete"
  return "update"
}

function relativePatchPath(filePath: string) {
  return filePath
    .replaceAll("\\", "/")
    .replace(/^[ab]\//, "")
    .replace(/^\/+/, "")
}

function unifiedPatch(filePath: string, patch: ReturnType<typeof parsePatch>[number]) {
  return [
    `Index: ${filePath}`,
    "===================================================================",
    `--- ${patch.oldFileName ?? filePath}\t${patch.oldHeader ?? ""}`,
    `+++ ${patch.newFileName ?? filePath}\t${patch.newHeader ?? ""}`,
    ...patch.hunks.flatMap((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines,
    ]),
    "",
  ].join("\n")
}
