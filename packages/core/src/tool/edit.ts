/**
 * Model-facing V2 exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as EditTool from "./edit"

import { ToolFailure } from "@opencode-ai/llm"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { LSP } from "../lsp"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "edit"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  oldString: Schema.String.annotate({ description: "Exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
  diagnostics: Schema.optional(Schema.String),
})
export type Output = typeof Output.Type

const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n")
const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n")
const convertToLineEnding = (text: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")

const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  return { bom, content, text: new TextDecoder().decode(bom ? content.slice(3) : content) }
}

const countOccurrences = (content: string, search: string) => {
  if (search === "") return content.length + 1
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}

const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()

const levenshtein = (left: string, right: string) => {
  if (left === "" || right === "") return Math.max(left.length, right.length)
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0]
    previous[0] = row
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column]
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
      diagonal = above
    }
  }
  return previous[right.length]
}

const correctedMatches = (content: string, search: string) => {
  const wanted = search.endsWith("\n") ? search.slice(0, -1) : search
  const wantedLines = wanted.split("\n")
  const contentLines = content.split("\n")
  const offsets = Array.from(content.matchAll(/^/gm), (match) => match.index)
  const candidates = contentLines
    .slice(0, Math.max(0, contentLines.length - wantedLines.length + 1))
    .map((_, index) => {
      const lines = contentLines.slice(index, index + wantedLines.length)
      const text = content.slice(offsets[index], offsets[index] + lines.join("\n").length)
      return { lines, text }
    })

  const direct = candidates.filter((candidate) =>
    candidate.lines.every((line, index) => line.trim() === wantedLines[index]?.trim()),
  )
  if (direct.length > 0) return direct.map((candidate) => candidate.text)

  const whitespace = candidates.filter(
    (candidate) => normalizeWhitespace(candidate.text) === normalizeWhitespace(wanted),
  )
  if (whitespace.length > 0) return whitespace.map((candidate) => candidate.text)
  if (wantedLines.length < 3) return []

  const anchored = candidates
    .filter(
      (candidate) =>
        candidate.lines[0]?.trim() === wantedLines[0]?.trim() &&
        candidate.lines.at(-1)?.trim() === wantedLines.at(-1)?.trim(),
    )
    .map((candidate) => {
      const middle = candidate.lines.slice(1, -1)
      const similarity =
        middle.reduce((total, line, index) => {
          const expected = wantedLines[index + 1]?.trim() ?? ""
          const actual = line.trim()
          const length = Math.max(actual.length, expected.length)
          return total + (length === 0 ? 1 : 1 - levenshtein(actual, expected) / length)
        }, 0) / Math.max(1, middle.length)
      return { ...candidate, similarity }
    })
    .filter((candidate) => candidate.similarity >= 0.65)
    .toSorted((left, right) => right.similarity - left.similarity)
  if (anchored.length === 0 || anchored[0]?.similarity === anchored[1]?.similarity) return []
  return [anchored[0].text]
}

const previewLines = (value: string, prefix: "+" | "-") => {
  const lines = normalizeLineEndings(value).split("\n")
  const shown = lines.slice(0, 6).map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`)
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

export const toModelOutput = (output: Output, oldString: string, newString: string) =>
  [
    `Edited file successfully: ${output.files[0]?.file}`,
    `Replacements: ${output.replacements}`,
    "```diff",
    ...previewLines(oldString, "-"),
    ...previewLines(newString, "+"),
    "```",
    ...(output.diagnostics ? [`\nLSP errors detected in this file, please fix:\n${output.diagnostics}`] : []),
  ].join("\n")

/** Deferred V2 edit behavior and UX integrations remain visible at the model-facing seam. */
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const lsp = yield* LSP.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Replace exact text in one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
            input: Input,
            output: Output,
            toModelOutput: ({ input, output }) => [
              { type: "text", text: toModelOutput(output, input.oldString, input.newString) },
            ],
            execute: (input, context) => {
              const unableToEdit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.mapError((error) =>
                    error instanceof FileMutation.StaleContentError
                      ? new ToolFailure({
                          message: "File changed after permission approval. Read it again before editing.",
                        })
                      : new ToolFailure({ message: `Unable to edit ${input.path}` }),
                  ),
                )

              return Effect.gen(function* () {
                const permissionSource = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (input.oldString === input.newString) {
                  return yield* new ToolFailure({
                    message: "No changes to apply: oldString and newString are identical.",
                  })
                }
                if (input.oldString === "") {
                  return yield* new ToolFailure({
                    message: "oldString must not be empty. Use write to create or overwrite a file.",
                  })
                }

                const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
                const external = target.externalDirectory
                if (external) {
                  yield* unableToEdit(
                    permission.assert({
                      ...LocationMutation.externalDirectoryPermission(external),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: permissionSource,
                    }),
                  )
                }

                yield* unableToEdit(
                  permission.assert({
                    action: "edit",
                    resources: [target.resource],
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: permissionSource,
                  }),
                )
                const source = decodeUtf8(yield* unableToEdit(fs.readFile(target.canonical)))
                const ending = detectLineEnding(source.text)
                const oldString = convertToLineEnding(input.oldString, ending)
                const newString = convertToLineEnding(input.newString, ending)
                const corrected = source.text.includes(oldString) ? [oldString] : correctedMatches(source.text, oldString)
                const matches = [...new Set(corrected)]
                if (matches.length > 1) {
                  return yield* new ToolFailure({
                    message: "Found multiple corrected matches for oldString. Provide more surrounding context.",
                  })
                }
                const search = matches[0] ?? oldString
                const replacements = countOccurrences(source.text, search)
                if (replacements === 0) {
                  return yield* new ToolFailure({
                    message:
                      "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
                  })
                }
                if (replacements > 1 && input.replaceAll !== true) {
                  return yield* new ToolFailure({
                    message:
                      "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.",
                  })
                }

                const replaced =
                  input.replaceAll === true ? source.text.replaceAll(search, newString) : source.text.replace(search, newString)
                const counts = diffLines(source.text, replaced).reduce(
                  (result, item) => ({
                    additions: result.additions + (item.added ? (item.count ?? 0) : 0),
                    deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
                  }),
                  { additions: 0, deletions: 0 },
                )
                const next = splitBom(replaced)
                const result = yield* unableToEdit(
                  files.writeIfUnchanged({
                    target,
                    expected: source.content,
                    content: joinBom(next.text, source.bom || next.bom),
                  }),
                )
                yield* lsp.touchFile(target.canonical, "document")
                const diagnostics = LSP.report(target.canonical, (yield* lsp.diagnostics())[target.canonical] ?? [])
                return {
                  files: [
                    {
                      file: result.resource,
                      patch: createTwoFilesPatch(result.resource, result.resource, source.text, replaced),
                      status: "modified" as const,
                      ...counts,
                    },
                  ],
                  replacements,
                  ...(diagnostics ? { diagnostics } : {}),
                } satisfies Output
              })
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/edit",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, FSUtil.node, PermissionV2.node, LSP.node],
})
