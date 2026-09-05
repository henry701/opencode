import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import { loadMcpQuery, loadMcpResourcesQuery } from "@/context/server-sync"
import type { Prompt, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const enabledAutoAccept: Array<{ server: string; sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{
  directory: string
  sessionID: string
  selection?: {
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string | null
    source?: "history" | "user"
  }
}> = []
const sentShell: string[] = []
const sessionLocations: Record<string, string> = {}
const syncedDirectories: string[] = []
const queuedDrafts: unknown[] = []
const promptAsyncCalls: unknown[] = []
const commandCalls: unknown[] = []
const currentCommands: Array<{ name: string; template: string; description?: string }> = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
const resumedQueues: string[] = []
const abortOrder: string[] = []
const todoCleared: string[] = []

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let permissionServer = "server-a"
let createSessionGate: Promise<void> | undefined

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const prompt = {
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  reset: () => undefined,
  set: () => undefined,
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => prompt,
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      create: async () => {
        await createSessionGate
        createdSessions.push(directory)
        return {
          data: {
            id: `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
          },
        }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async (input: unknown) => {
        promptAsyncCalls.push(input)
        return { data: undefined }
      },
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: () => 0,
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
    base64Decode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(
          directory: string,
          sessionID: string,
          selection?: {
            agent?: string
            model?: { providerID: string; modelID: string }
            variant?: string | null
            source?: "history" | "user"
          },
        ) {
          promoted.push({ directory, sessionID, selection })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => {
    const state = (server: string) => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ server, sessionID, directory })
      },
    })
    return { usePermission: () => ({ currentServerState: () => state(permissionServer) }) }
  })

  mock.module("@/context/server", () => ({
    ServerConnection: {
      Key: { make: (value: string) => value },
      key: (conn: { type?: string; http?: { url?: string } } | string) =>
        typeof conn === "string" ? conn : conn.type === "sidecar" ? "sidecar" : (conn.http?.url ?? "local"),
      local: (conn?: { type?: string; http?: { url?: string } }) =>
        !conn || conn.type === "sidecar" || conn.http?.url === "http://localhost:4096",
    },
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      draft: () => ({ server: "project-server" }),
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/server-sdk", () => ({
    useServerSDK: () => () => ({
      currentClient: {
        commands: {
          list: async () => ({
            location: { directory: "/repo/main", project: { id: "project", directory: "/repo/main" } },
            data: currentCommands,
          }),
        },
        sessions: {
          create: async (input: { location?: { directory?: string } }) => {
            await createSessionGate
            const directory = input.location?.directory ?? "/repo/main"
            createdSessions.push(directory)
            sessionLocations[`session-${createdSessions.length}`] = directory
            return {
              id: `session-${createdSessions.length}`,
              title: `New session ${createdSessions.length}`,
            }
          },
          prompt: async (input: unknown) => {
            promptAsyncCalls.push(input)
            return { id: "input-1" }
          },
          interrupt: async () => {
            abortOrder.push("interrupt")
          },
          shell: async (input: { sessionID: string }) => {
            sentShell.push(sessionLocations[input.sessionID] ?? input.sessionID)
          },
          queueDrainResume: async (input: { sessionID: string }) => {
            resumedQueues.push(input.sessionID)
          },
          command: async (input: unknown) => {
            commandCalls.push(input)
            return { id: "input-command" }
          },
        },
      },
    }),
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: [] },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: (...args: unknown[]) => {
        if (args[0] === "todo" && typeof args[1] === "string") todoCleared.push(args[1])
      },
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    loadMcpResourcesQuery,
    loadMcpQuery,
    useServerSync: () => () => ({
      session: {
        remember: () => undefined,
        set: () => undefined,
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  params = {}
  search = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  queuedDrafts.length = 0
  promptAsyncCalls.length = 0
  commandCalls.length = 0
  currentCommands.length = 0
  resumedQueues.length = 0
  abortOrder.length = 0
  todoCleared.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  permissionServer = "server-a"
  createSessionGate = undefined
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
  for (const key of Object.keys(sessionLocations)) delete sessionLocations[key]
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(promoted).toEqual([
      {
        directory: "/repo/worktree-a",
        sessionID: "session-1",
        selection: {
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
          variant: null,
          source: "user",
        },
      },
      {
        directory: "/repo/worktree-b",
        sessionID: "session-2",
        selection: {
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
          variant: null,
          source: "user",
        },
      },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("keeps auto-accept bound to the submission server", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    permissionServer = "server-b"
    release()
    await result

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test("promotes new sessions with the submitted model selection", async () => {
    variant = "high"
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promoted).toEqual([
      {
        directory: "/repo/worktree-a",
        sessionID: "session-1",
        selection: {
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
          variant: "high",
          source: "user",
        },
      },
    ])
  })

  test("includes the selected variant on durable current prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(promptAsyncCalls).toHaveLength(1)
    expect(resumedQueues).toEqual(["session-1"])
    expect(promptAsyncCalls[0]).toMatchObject({
      sessionID: "session-1",
      payload: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promptAsyncCalls[0]).toMatchObject({
      payload: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("creates the current session before admitting its first prompt", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(createdSessions).toEqual(["/repo/worktree-a"])
    expect(promptAsyncCalls).toEqual([
      expect.objectContaining({
        sessionID: "session-1",
        payload: expect.objectContaining({ agent: "agent" }),
      }),
    ])
  })
})

describe("prompt submit queue mode", () => {
  test("replaces a staged rollback instead of queueing or repeating it", async () => {
    params = { id: "session-1" }
    const order: string[] = []
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      queueMode: () => true,
      revertMessageID: () => "message-1",
      onRevertSubmit: async (messageID) => {
        order.push(`stage:${messageID}`)
      },
      onRevertSubmitComplete: () => order.push("complete"),
      onSubmit: () => order.push("submit"),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(order).toEqual(["stage:message-1", "submit"])
    expect(promptAsyncCalls).toHaveLength(1)
    expect(resumedQueues).toEqual(["session-1"])
    expect(queuedDrafts).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(["stage:message-1", "submit", "complete"])
  })

  test("pauses queue draining before interrupting and preserves admitted input", async () => {
    params = { id: "session-1" }
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onAbortComplete: () => {
        abortOrder.push("complete")
      },
      onAbort: async () => {
        await gate
        abortOrder.push("pause")
      },
    })

    const pending = submit.abort()
    await Promise.resolve()
    expect(abortOrder).toEqual([])
    release()
    await pending

    expect(abortOrder).toEqual(["pause", "interrupt", "complete"])
    expect(todoCleared).toEqual([])
    expect(promptAsyncCalls).toHaveLength(0)
  })

  test("recognizes queued slash commands from the current catalog before routing the draft", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "/review now", start: 0, end: 11 }]
    currentCommands.push({ name: "review", template: "Review $ARGUMENTS" })

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => true,
      onQueue: (draft) => {
        queuedDrafts.push(draft)
      },
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(queuedDrafts).toEqual([
      expect.objectContaining({
        command: { name: "review", arguments: "now" },
      }),
    ])
    expect(commandCalls).toHaveLength(0)
    expect(promptAsyncCalls).toHaveLength(0)
  })

  test("gives direct custom command submissions a stable retry id", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "/review now", start: 0, end: 11 }]
    currentCommands.push({ name: "review", template: "Review $ARGUMENTS" })

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(commandCalls).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^msg_/),
        sessionID: "session-1",
        name: "review",
        arguments: "now",
      }),
    ])
    expect(promptAsyncCalls).toHaveLength(0)
  })

  test("queueMode routes existing sessions through onQueue", async () => {
    params = { id: "session-1" }

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      queueMode: () => true,
      resetQueueMode: () => undefined,
      onQueue: (draft) => {
        queuedDrafts.push(draft)
      },
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(queuedDrafts).toHaveLength(1)
    expect(promptAsyncCalls).toHaveLength(0)
  })

  test("editingQueueID is forwarded on queue submit", async () => {
    params = { id: "session-1" }

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      queueMode: () => true,
      resetQueueMode: () => undefined,
      editingQueueID: () => "pqu_edit",
      resetEditingQueueID: () => undefined,
      onQueue: (draft) => {
        queuedDrafts.push(draft)
      },
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(queuedDrafts).toHaveLength(1)
    expect(queuedDrafts[0]).toMatchObject({ queueID: "pqu_edit" })
  })

  test("editing a queued prompt retains the complete durable payload", async () => {
    params = { id: "session-1" }
    const payload = {
      version: 1 as const,
      agent: "reviewer",
      model: { providerID: "provider", modelID: "model", variant: "high" },
      tools: { bash: false },
      system: "exact system",
      format: { type: "text" as const },
      parts: [{ type: "text" as const, text: "hidden", synthetic: true }],
    }

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      editingQueueID: () => "pqu_edit",
      editingQueuePayload: () => payload,
      onQueue: (draft) => {
        queuedDrafts.push(draft)
      },
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(queuedDrafts[0]).toMatchObject({
      queueID: "pqu_edit",
      queuePayload: payload,
    })
  })

  test("waits for durable queue persistence before completing an edit", async () => {
    params = { id: "session-1" }
    const order: string[] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      editingQueueID: () => "pqu_edit",
      resetEditingQueueID: () => order.push("reset"),
      onQueue: async () => {
        await gate
        order.push("persisted")
      },
    })

    const pending = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()
    expect(order).toEqual([])
    release()
    await pending
    expect(order).toEqual(["persisted", "reset"])
  })

  test("editingQueueID commits through onQueue when queue mode is inactive", async () => {
    params = { id: "session-1" }

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => false,
      editingQueueID: () => "pqu_edit",
      resetEditingQueueID: () => undefined,
      onQueue: (draft) => {
        queuedDrafts.push(draft)
      },
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(queuedDrafts).toHaveLength(1)
    expect(queuedDrafts[0]).toMatchObject({ queueID: "pqu_edit" })
    expect(promptAsyncCalls).toHaveLength(0)
  })

  test("shouldQueue routes existing sessions through onQueue", async () => {
    params = { id: "session-1" }

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => true,
      onQueue: (draft) => {
        queuedDrafts.push(draft)
      },
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(queuedDrafts).toHaveLength(1)
    expect(promptAsyncCalls).toHaveLength(0)
  })
})

describe("sendFollowupDraft delivery", () => {
  test("forwards delivery and the complete payload to the current prompt API", async () => {
    const { sendFollowupDraft } = await import("./submit")
    const calls: unknown[] = []

    await sendFollowupDraft({
      client: {
        sessions: {
          prompt: async (input: unknown) => {
            calls.push(input)
            return { id: "input-1" }
          },
        },
      } as never,
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "follow up", start: 0, end: 9 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
      delivery: "queue",
    })

    expect(calls).toEqual([
      expect.objectContaining({
        delivery: "queue",
        sessionID: "session-1",
        payload: expect.objectContaining({
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
        }),
      }),
    ])
  })
})
