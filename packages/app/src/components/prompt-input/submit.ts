import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, startTransition, type Accessor } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import type { CurrentClient, SessionsPromptInput } from "@/utils/current-client"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { setCursorPosition } from "./editor-dom"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { createSessionPayload } from "./session-payload"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  /** When set, save replaces this queued item instead of appending. */
  queueID?: string
  /** Original durable payload retained while editing so hidden controls and parts survive. */
  queuePayload?: SessionsPromptInput["payload"]
  /** A recognized custom slash command that still needs server-side expansion. */
  command?: { name: string; arguments: string }
}

type FollowupSendInput = {
  client: CurrentClient
  draft: FollowupDraft
  messageID?: string
  delivery?: SessionsPromptInput["delivery"]
  before?: () => Promise<boolean> | boolean
}

export async function sendFollowupDraft(input: FollowupSendInput) {
  const messageID = input.messageID ?? Identifier.ascending("message")
  if ((await input.before?.()) === false) return false
  await input.client.sessions.prompt({
    sessionID: input.draft.sessionID,
    id: messageID,
    payload: createSessionPayload(input.draft),
    delivery: input.delivery,
    resume: true,
  })
  return true
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  queueMode?: Accessor<boolean>
  resetQueueMode?: () => void
  editingQueueID?: Accessor<string | undefined>
  editingQueuePayload?: Accessor<SessionsPromptInput["payload"] | undefined>
  resetEditingQueueID?: () => void
  onQueue?: (draft: FollowupDraft) => Promise<void> | void
  onAbort?: () => void
  onSubmit?: () => void
  model?: ModelSelection
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    serverSync().session.set("todo", sessionID, [])

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return serverSDK().currentClient.sessions.interrupt({ sessionID }).catch(() => {})
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()
    const queueMode = input.queueMode?.() ?? false

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const modelState = input.model ?? local.model
    const currentModel = modelState.current()
    const currentAgent = local.agent.current()
    const variant = modelState.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk().directory
    const permissionState = permission.currentServerState()
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"
    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const selectedModel = {
      ...model,
      ...(currentModel.name ? { name: currentModel.name } : {}),
      ...(currentModel.provider.name ? { providerName: currentModel.provider.name } : {}),
    }
    const agent = currentAgent.name

    let sessionDirectory = projectDirectory
    let client = sdk().client

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(sdk().scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk().createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync().child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info() ?? (params.id ? { id: params.id } : undefined)
    if (!session && isNewSession) {
      const created = await serverSDK().currentClient.sessions
        .create({
          agent,
          model: { id: model.modelID, providerID: model.providerID, variant },
          location: { directory: sessionDirectory },
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        session = created
        await startTransition(() => {
          if (!session) return
          if (shouldAutoAccept) permissionState.enableAutoAccept(session.id, sessionDirectory)
          local.session.promote(sessionDirectory, session.id, {
            agent,
            model: selectedModel,
            variant: variant ?? null,
            source: "user",
          })
          layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
          const draftID = search.draftId
          if (draftID) tabs.promoteDraft(draftID, { server: tabs.draft(draftID).server, sessionId: session.id })
          else navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
          submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: session.id }))
        })
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const commandInput = mode === "normal" ? text.match(/^\/(\S+)(?:[ \t]+([\s\S]*))?$/) : undefined
    const commandName = commandInput?.[1]
    const commands = commandName
      ? await serverSDK().currentClient.commands
          .list({ location: { directory: sessionDirectory } })
          .then((result) => result.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })
      : []
    if (commandName && !commands) return
    const customCommand = commands?.find((command) => command.name === commandName)
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
      queueID: input.editingQueueID?.(),
      queuePayload: input.editingQueuePayload?.(),
      ...(customCommand && commandName
        ? { command: { name: commandName, arguments: commandInput?.[2] ?? "" } }
        : {}),
    }

    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (!isNewSession && mode === "normal" && (draft.queueID || input.shouldQueue?.() || queueMode)) {
      const saved = await Promise.resolve(input.onQueue?.(draft))
        .then(() => true)
        .catch((err) => {
          showToast({
            title: language.t("common.requestFailed"),
            description: errorMessage(err),
          })
          return false
        })
      if (!saved) return
      input.resetQueueMode?.()
      if (draft.queueID) input.resetEditingQueueID?.()
      clearContext(submission.target())
      clearInput()
      return
    }

    input.resetQueueMode?.()

    void serverSDK().currentClient.sessions.queueDrainResume({ sessionID: session.id }).catch(() => {})

    input.onSubmit?.()

    if (mode === "shell") {
      clearInput()
      serverSDK().currentClient.sessions
        .shell({ sessionID: session.id, command: text })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (draft.command) {
      clearInput()
      serverSDK().currentClient.sessions
        .command({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          name: draft.command.name,
          arguments: draft.command.arguments,
          payload: createSessionPayload(draft),
          resume: true,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.commandSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sdk().scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      client: serverSDK().currentClient,
      draft,
      messageID,
      before: waitForWorktree,
    }).catch((err) => {
      pending.delete(pendingKey(session.id))
      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
