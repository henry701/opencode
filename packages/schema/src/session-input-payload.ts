export * as SessionInputPayload from "./session-input-payload"

import { Effect, Schema } from "effect"
import { Model } from "./model"
import { Prompt } from "./prompt"
import { Provider } from "./provider"
import { NonNegativeInt, optional } from "./schema"

export const ProviderID = Provider.ID
export type ProviderID = Provider.ID
export const ModelID = Model.ID
export type ModelID = Model.ID
export const VariantID = Model.VariantID
export type VariantID = Model.VariantID

const SourceText = Schema.Struct({
  value: Schema.String,
  start: Schema.Finite,
  end: Schema.Finite,
})

const Range = Schema.Struct({
  start: Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt }),
  end: Schema.Struct({ line: NonNegativeInt, character: NonNegativeInt }),
})

export const FileSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("file"),
    path: Schema.String,
    text: SourceText,
  }),
  Schema.Struct({
    type: Schema.Literal("symbol"),
    path: Schema.String,
    range: Range,
    name: Schema.String,
    kind: NonNegativeInt,
    text: SourceText,
  }),
  Schema.Struct({
    type: Schema.Literal("resource"),
    clientName: Schema.String,
    uri: Schema.String,
    text: SourceText,
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "SessionInputPayload.FileSource" })

export const TextPart = Schema.Struct({
  id: Schema.String.pipe(optional),
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.Boolean.pipe(optional),
  ignored: Schema.Boolean.pipe(optional),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt.pipe(optional),
  }).pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(optional),
}).annotate({ identifier: "SessionInputPayload.TextPart" })

export const FilePart = Schema.Struct({
  id: Schema.String.pipe(optional),
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.String.pipe(optional),
  url: Schema.String,
  source: FileSource.pipe(optional),
}).annotate({ identifier: "SessionInputPayload.FilePart" })

export const AgentPart = Schema.Struct({
  id: Schema.String.pipe(optional),
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.Struct({
    value: Schema.String,
    start: NonNegativeInt,
    end: NonNegativeInt,
  }).pipe(optional),
}).annotate({ identifier: "SessionInputPayload.AgentPart" })

export const SubtaskPart = Schema.Struct({
  id: Schema.String.pipe(optional),
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.Struct({
    providerID: ProviderID,
    modelID: ModelID,
    variant: VariantID.pipe(optional),
  }).pipe(optional),
  command: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionInputPayload.SubtaskPart" })

export const Part = Schema.Union([TextPart, FilePart, AgentPart, SubtaskPart])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "SessionInputPayload.Part" })
export type Part = typeof Part.Type

export const Format = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text") }),
  Schema.Struct({
    type: Schema.Literal("json_schema"),
    schema: Schema.Record(Schema.String, Schema.Json),
    retryCount: NonNegativeInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "SessionInputPayload.Format" })
export type Format = typeof Format.Type

export const Permission = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  action: Schema.Literals(["allow", "deny", "ask"]),
}).annotate({ identifier: "SessionInputPayload.Permission" })

export const Payload = Schema.Struct({
  version: Schema.Literal(1),
  agent: Schema.String,
  model: Schema.Struct({
    providerID: ProviderID,
    modelID: ModelID,
    variant: VariantID.pipe(optional),
  }),
  tools: Schema.Record(Schema.String, Schema.Boolean).pipe(optional),
  system: Schema.String.pipe(optional),
  format: Format.pipe(optional),
  parts: Schema.Array(Part),
  permissions: Schema.Array(Permission).pipe(optional),
}).annotate({ identifier: "SessionInputPayload" })
export interface Payload extends Schema.Schema.Type<typeof Payload> {}
export type Encoded = typeof Payload.Encoded

export const toPrompt = (payload: Payload) =>
  Prompt.make({
    text: payload.parts
      .flatMap((part) => {
        if (part.type === "text") return part.ignored === true ? [] : [part.text]
        if (part.type === "subtask") return [part.prompt]
        return []
      })
      .join("\n"),
    files: payload.parts.flatMap((part) =>
      part.type === "file"
        ? [
            {
              uri: part.url,
              mime: part.mime,
              ...(part.filename === undefined ? {} : { name: part.filename }),
            },
          ]
        : [],
    ),
    agents: payload.parts.flatMap((part) =>
      part.type === "agent"
        ? [
            {
              name: part.name,
              ...(part.source === undefined
                ? {}
                : {
                    source: {
                      text: part.source.value,
                      start: part.source.start,
                      end: part.source.end,
                    },
                  }),
            },
          ]
        : [],
    ),
  })
