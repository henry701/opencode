import type { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import type {
  AgentPart,
  FileAttachmentPart,
  ImageAttachmentPart,
  Prompt,
} from "@/context/prompt"
import { createLegacyBlobReference } from "@/utils/draft-store"

type Inline =
  | {
      type: "file"
      start: number
      end: number
      value: string
      path: string
      selection?: FileAttachmentPart["selection"]
    }
  | {
      type: "agent"
      start: number
      end: number
      value: string
      name: string
    }

type Payload = SessionInputPayload.Payload | SessionInputPayload.Encoded
export function promptFromSessionPayload(
  payload: Payload,
  options?: { directory?: string; attachmentName?: string },
) {
  const text =
    payload.parts
      .flatMap((part) =>
        part.type === "text" && part.synthetic !== true && part.ignored !== true ? [part.text] : [],
      )
      .reduce((longest, part) => (part.length > longest.length ? part : longest), "")
  const relative = (value: string) => {
    const directory = options?.directory
    if (!directory) return value
    const prefix = directory.endsWith("/") ? directory : directory + "/"
    if (value.startsWith(prefix)) return value.slice(prefix.length)
    return value
  }
  const selection = (url: string) => {
    const query = url.indexOf("?")
    if (query === -1) return
    const params = new URLSearchParams(url.slice(query + 1))
    const startLine = Number(params.get("start"))
    const endLine = Number(params.get("end"))
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return
    return { startLine, endLine, startChar: 0, endChar: 0 }
  }
  const inline = payload.parts
    .flatMap((part): Inline[] => {
      if (part.type === "file" && part.source)
        return [
          {
            type: "file",
            start: part.source.text.start,
            end: part.source.text.end,
            value: part.source.text.value,
            path: relative(part.source.type === "resource" ? part.source.uri : part.source.path),
            selection: selection(part.url),
          },
        ]
      if (part.type === "agent" && part.source)
        return [
          {
            type: "agent",
            start: part.source.start,
            end: part.source.end,
            value: part.source.value,
            name: part.name,
          },
        ]
      return []
    })
    .toSorted((left, right) => left.start - right.start || left.end - right.end)
  const images = payload.parts.flatMap((part): ImageAttachmentPart[] =>
    part.type === "file" && !part.source && part.url.startsWith("data:")
      ? [
          {
            type: "image",
            id: part.id ?? part.url,
            filename: part.filename ?? options?.attachmentName ?? "attachment",
            mime: part.mime,
            blob: createLegacyBlobReference(part.url),
          },
        ]
      : [],
  )
  const result: Prompt = []
  let position = 0
  let cursor = 0
  const pushText = (content: string) => {
    if (!content) return
    result.push({ type: "text", content, start: position, end: position + content.length })
    position += content.length
  }

  inline.forEach((item) => {
    if (item.start < 0 || item.end < item.start || !item.value) return
    const mismatch = item.end > text.length || item.start < cursor || text.slice(item.start, item.end) !== item.value
    const start = mismatch ? text.indexOf(item.value, cursor) : item.start
    if (start === -1) return
    const end = mismatch ? start + item.value.length : item.end
    pushText(text.slice(cursor, start))
    if (item.type === "file") {
      const part: FileAttachmentPart = {
        type: "file",
        path: item.path,
        content: item.value,
        start: position,
        end: position + item.value.length,
        selection: item.selection,
      }
      result.push(part)
    }
    if (item.type === "agent") {
      const part: AgentPart = {
        type: "agent",
        name: item.name,
        content: item.value,
        start: position,
        end: position + item.value.length,
      }
      result.push(part)
    }
    position += item.value.length
    cursor = end
  })

  pushText(text.slice(cursor))
  if (result.length === 0) result.push({ type: "text", content: "", start: 0, end: 0 })
  return images.length === 0 ? result : [...result, ...images]
}
