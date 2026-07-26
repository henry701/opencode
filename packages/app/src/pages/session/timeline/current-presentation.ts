import type { Model } from "@opencode-ai/schema/model"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import type { SessionEvent } from "@opencode-ai/schema/session-event"
import { parseCommentNote, readCommentMetadata, type PromptComment } from "@/utils/comment-note"
import { TimelineRow, type SummaryDiff } from "./timeline-row"

type TurnMessage = SessionMessage.User | SessionMessage.Shell

export type CurrentTimelineTurn = {
  message: TurnMessage
  agent?: string
  model?: Model.Ref
  assistants: SessionMessage.Assistant[]
  compactions: SessionMessage.Compaction[]
  comments: PromptComment[]
  diffs: SummaryDiff[]
}

export type CurrentTimelinePresentation = {
  messages: readonly SessionMessage.Message[]
  turns: CurrentTimelineTurn[]
  retry?: SessionEvent.Retried
}

export function presentCurrentTimeline(input: {
  messages: readonly SessionMessage.Message[]
  agent?: string
  model?: Model.Ref
  retry?: SessionEvent.Retried
}): CurrentTimelinePresentation {
  const turns: CurrentTimelineTurn[] = []
  const state: { agent?: string; model?: Model.Ref; turn?: CurrentTimelineTurn } = {
    agent: input.agent,
    model: input.model,
  }

  input.messages.forEach((message) => {
    if (message.type === "agent-switched") {
      state.agent = message.agent
      return
    }
    if (message.type === "model-switched") {
      state.model = message.model
      return
    }
    if (message.type === "user") {
      if (message.payload) {
        state.agent = message.payload.agent
        state.model = {
          providerID: message.payload.model.providerID,
          id: message.payload.model.modelID,
          variant: message.payload.model.variant,
        }
      }
      state.turn = {
        message,
        agent: state.agent,
        model: state.model,
        assistants: [],
        compactions: [],
        comments: comments(message),
        diffs: [],
      }
      turns.push(state.turn)
      return
    }
    if (message.type === "shell") {
      state.turn = {
        message,
        agent: state.agent,
        model: state.model,
        assistants: [],
        compactions: [],
        comments: [],
        diffs: [],
      }
      turns.push(state.turn)
      return
    }
    if (message.type === "assistant") {
      state.turn?.assistants.push(message)
      if (state.turn && message.snapshot?.diffs) state.turn.diffs.push(...message.snapshot.diffs.flatMap(summaryDiff))
      return
    }
    if (message.type === "compaction") state.turn?.compactions.push(message)
  })

  return {
    messages: input.messages,
    turns,
    retry: input.retry,
  }
}

export function currentTimelineRows(
  presentation: CurrentTimelinePresentation,
  active: boolean,
  showReasoning: boolean,
  inlineComments = false,
) {
  return presentation.turns.flatMap((turn, index) => {
    const rows: TimelineRow.TimelineRow[] = []
    if (index > 0) rows.push(new TimelineRow.TurnGap({ userMessageID: turn.message.id }))
    if (turn.comments.length > 0 && !inlineComments)
      rows.push(new TimelineRow.CommentStrip({ userMessageID: turn.message.id }))
    rows.push(
      new TimelineRow.UserMessage({
        userMessageID: turn.message.id,
        anchor: inlineComments || turn.comments.length === 0,
      }),
    )
    turn.compactions.forEach(() => {
      rows.push(new TimelineRow.TurnDivider({ userMessageID: turn.message.id, label: "compaction" }))
    })
    let assistantGroupIndex = 0
    turn.assistants.forEach((assistant) => {
      const visible = assistant.content.filter((content) => {
        if (content.type === "text") return Boolean(content.text.trim())
        if (content.type === "reasoning") return showReasoning && Boolean(content.text.trim())
        if (content.name === "todowrite") return false
        return content.name !== "question" || (content.state.status !== "pending" && content.state.status !== "running")
      })
      let context: SessionMessage.AssistantTool[] = []
      const pushContext = () => {
        const first = context[0]
        if (!first) return
        rows.push(
          new TimelineRow.AssistantPart({
            userMessageID: turn.message.id,
            group: {
              key: `current-context:${assistant.id}:${first.id}`,
              type: "context",
              refs: context.map((content) => ({ messageID: assistant.id, partID: content.id })),
            },
            previousAssistantPart: assistantGroupIndex > 0,
          }),
        )
        assistantGroupIndex++
        context = []
      }
      visible.forEach((content) => {
        if (content.type === "tool" && contextTools.has(content.name)) {
          context.push(content)
          return
        }
        pushContext()
        rows.push(
          new TimelineRow.AssistantPart({
            userMessageID: turn.message.id,
            group: {
              key: `current:${assistant.id}:${content.id}`,
              type: "part",
              ref: { messageID: assistant.id, partID: content.id },
            },
            previousAssistantPart: assistantGroupIndex > 0,
          }),
        )
        assistantGroupIndex++
      })
      pushContext()
      if (assistant.error?.type === "interrupted")
        rows.push(new TimelineRow.TurnDivider({ userMessageID: turn.message.id, label: "interrupted" }))
      else if (assistant.error)
        rows.push(
          new TimelineRow.Error({
            userMessageID: turn.message.id,
            text: assistant.error.message,
          }),
        )
    })
    const last = turn.assistants.at(-1)
    if (active && presentation.retry && index === presentation.turns.length - 1) {
      rows.push(new TimelineRow.Retry({ userMessageID: turn.message.id }))
    } else if (
      active &&
      (!last || last.time.completed === undefined) &&
      (showReasoning ? assistantGroupIndex === 0 : true)
    )
      rows.push(
        new TimelineRow.Thinking({
          userMessageID: turn.message.id,
          reasoningHeading: turn.assistants
            .flatMap((assistant) => assistant.content)
            .map((content) => (content.type === "reasoning" ? reasoningHeading(content.text) : undefined))
            .find((value): value is string => Boolean(value)),
        }),
      )
    if ((!active || index < presentation.turns.length - 1) && turn.diffs.length > 0)
      rows.push(new TimelineRow.DiffSummary({ userMessageID: turn.message.id, diffs: turn.diffs }))
    return rows
  })
}

const contextTools = new Set(["read", "list", "glob", "grep"])

function comments(message: SessionMessage.User) {
  return (message.payload?.parts ?? []).flatMap((part) => {
    if (part.type !== "text" || part.synthetic !== true) return []
    const comment = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    return comment ? [comment] : []
  })
}

function summaryDiff(value: NonNullable<NonNullable<SessionMessage.Assistant["snapshot"]>["diffs"]>[number]) {
  if (!value.file) return []
  return [{ ...value, file: value.file } satisfies SummaryDiff]
}

function reasoningHeading(text: string) {
  const markdown = text.replace(/\r\n?/g, "\n")
  const match =
    markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1]?.replace(/<[^>]+>/g, " ") ??
    markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)?.[1] ??
    markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)?.[1] ??
    markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)?.[1]
  return match
    ?.replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]+/g, "")
    .trim()
}
