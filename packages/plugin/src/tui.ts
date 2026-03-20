import type {
  createOpencodeClient as createOpencodeClientV2,
  Event as TuiEvent,
  LspStatus,
  McpStatus,
  Todo,
} from "@opencode-ai/sdk/v2"
import type { CliRenderer, ParsedKey, Plugin as CorePlugin } from "@opentui/core"
import type { Plugin as ServerPlugin, PluginOptions } from "./index.js"

export type { CliRenderer, SlotMode } from "@opentui/core"

export type TuiRouteCurrent =
  | {
      name: "home"
    }
  | {
      name: "session"
      params: {
        sessionID: string
        initialPrompt?: unknown
      }
    }
  | {
      name: string
      params?: Record<string, unknown>
    }

export type TuiRouteDefinition<Node = unknown> = {
  name: string
  render: (input: { params?: Record<string, unknown> }) => Node
}

export type TuiCommand = {
  title: string
  value: string
  description?: string
  category?: string
  keybind?: string
  suggested?: boolean
  hidden?: boolean
  enabled?: boolean
  slash?: {
    name: string
    aliases?: string[]
  }
  onSelect?: () => void
}

export type TuiKeybind = {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  super?: boolean
  leader: boolean
}

export type TuiKeybindMap = Record<string, string>

export type TuiKeybindSet = {
  readonly all: TuiKeybindMap
  get: (name: string) => string
  parse: (evt: ParsedKey) => TuiKeybind
  match: (name: string, evt: ParsedKey) => boolean
  print: (name: string) => string
}

export type TuiDialogProps<Node = unknown> = {
  size?: "medium" | "large"
  onClose: () => void
  children?: Node
}

export type TuiDialogStack<Node = unknown> = {
  replace: (render: () => Node, onClose?: () => void) => void
  clear: () => void
  setSize: (size: "medium" | "large") => void
  readonly size: "medium" | "large"
  readonly depth: number
  readonly open: boolean
}

export type TuiDialogAlertProps = {
  title: string
  message: string
  onConfirm?: () => void
}

export type TuiDialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
}

export type TuiDialogPromptProps<Node = unknown> = {
  title: string
  description?: () => Node
  placeholder?: string
  value?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export type TuiDialogSelectOption<Value = unknown, Node = unknown> = {
  title: string
  value: Value
  description?: string
  footer?: Node | string
  category?: string
  disabled?: boolean
  onSelect?: () => void
}

export type TuiDialogSelectProps<Value = unknown, Node = unknown> = {
  title: string
  placeholder?: string
  options: TuiDialogSelectOption<Value, Node>[]
  flat?: boolean
  onMove?: (option: TuiDialogSelectOption<Value, Node>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: TuiDialogSelectOption<Value, Node>) => void
  skipFilter?: boolean
  current?: Value
}

export type TuiToast = {
  variant?: "info" | "success" | "warning" | "error"
  title?: string
  message: string
  duration?: number
}

export type TuiTheme = {
  readonly current: Record<string, unknown>
  readonly selected: string
  has: (name: string) => boolean
  set: (name: string) => boolean
  install: (jsonPath: string) => Promise<void>
  mode: () => "dark" | "light"
  readonly ready: boolean
}

export type TuiKV = {
  get: <Value = unknown>(key: string, fallback?: Value) => Value
  set: (key: string, value: unknown) => void
  readonly ready: boolean
}

export type TuiState = {
  session: {
    diff: (sessionID: string) => ReadonlyArray<TuiSidebarFileItem>
    todo: (sessionID: string) => ReadonlyArray<TuiSidebarTodoItem>
  }
  lsp: () => ReadonlyArray<TuiSidebarLspItem>
  mcp: () => ReadonlyArray<TuiSidebarMcpItem>
}

export type TuiApi<Node = unknown> = {
  command: {
    register: (cb: () => TuiCommand[]) => void
    trigger: (value: string) => void
  }
  route: {
    register: (routes: TuiRouteDefinition<Node>[]) => () => void
    navigate: (name: string, params?: Record<string, unknown>) => void
    readonly current: TuiRouteCurrent
  }
  ui: {
    Dialog: (props: TuiDialogProps<Node>) => Node
    DialogAlert: (props: TuiDialogAlertProps) => Node
    DialogConfirm: (props: TuiDialogConfirmProps) => Node
    DialogPrompt: (props: TuiDialogPromptProps<Node>) => Node
    DialogSelect: <Value = unknown>(props: TuiDialogSelectProps<Value, Node>) => Node
    toast: (input: TuiToast) => void
    dialog: TuiDialogStack<Node>
  }
  keybind: {
    parse: (evt: ParsedKey) => TuiKeybind
    match: (key: string, evt: ParsedKey) => boolean
    print: (key: string) => string
    create: (defaults: TuiKeybindMap, overrides?: Record<string, unknown>) => TuiKeybindSet
  }
  kv: TuiKV
  state: TuiState
  theme: TuiTheme
}

export type TuiSidebarMcpItem = {
  name: string
  status: McpStatus["status"]
  error?: string
}

export type TuiSidebarLspItem = Pick<LspStatus, "id" | "root" | "status">

export type TuiSidebarTodoItem = Pick<Todo, "content" | "status">

export type TuiSidebarFileItem = {
  file: string
  additions: number
  deletions: number
}

export type TuiSlotMap = {
  app: {}
  home_logo: {}
  home_tips: {
    show_tips: boolean
    tips_hidden: boolean
    first_time_user: boolean
  }
  home_below_tips: {
    show_tips: boolean
    tips_hidden: boolean
    first_time_user: boolean
  }
  sidebar_top: {
    session_id: string
  }
  sidebar_title: {
    session_id: string
    title: string
    share_url?: string
  }
  sidebar_context: {
    session_id: string
    tokens: number
    percentage: number | null
    cost: number
  }
  sidebar_mcp: {
    session_id: string
    items: TuiSidebarMcpItem[]
    connected: number
    errors: number
  }
  sidebar_lsp: {
    session_id: string
    items: TuiSidebarLspItem[]
    disabled: boolean
  }
  sidebar_todo: {
    session_id: string
    items: TuiSidebarTodoItem[]
  }
  sidebar_files: {
    session_id: string
    items: TuiSidebarFileItem[]
  }
  sidebar_getting_started: {
    session_id: string
    show_getting_started: boolean
    has_providers: boolean
    dismissed: boolean
  }
  sidebar_directory: {
    session_id: string
    directory: string
    directory_parent: string
    directory_name: string
  }
  sidebar_version: {
    session_id: string
    version: string
  }
  sidebar_bottom: {
    session_id: string
    directory: string
    directory_parent: string
    directory_name: string
    version: string
    show_getting_started: boolean
    has_providers: boolean
    dismissed: boolean
  }
}

export type TuiSlotContext = {
  theme: TuiTheme
}

export type TuiSlotPlugin<Node = unknown> = CorePlugin<Node, TuiSlotMap, TuiSlotContext>

export type TuiSlots = {
  register: (plugin: TuiSlotPlugin) => () => void
}

export type TuiEventBus = {
  on: <Type extends TuiEvent["type"]>(
    type: Type,
    handler: (event: Extract<TuiEvent, { type: Type }>) => void,
  ) => () => void
}

export type TuiPluginState = "first" | "updated" | "same"

export type TuiPluginMeta = {
  name: string
  source: "file" | "npm" | "internal"
  spec: string
  target: string
  requested?: string
  version?: string
  modified?: number
  first_time: number
  last_time: number
  time_changed: number
  load_count: number
  fingerprint: string
}

export type TuiPluginInit = {
  state: TuiPluginState
  entry: TuiPluginMeta
}

export type TuiPluginInput<Renderer = CliRenderer, Node = unknown> = {
  client: ReturnType<typeof createOpencodeClientV2>
  event: TuiEventBus
  renderer: Renderer
  slots: TuiSlots
  api: TuiApi<Node>
}

export type TuiPlugin<Renderer = CliRenderer, Node = unknown> = (
  input: TuiPluginInput<Renderer, Node>,
  options: PluginOptions | undefined,
  init: TuiPluginInit,
) => Promise<void>

export type TuiPluginModule<Renderer = CliRenderer, Node = unknown> = {
  server?: ServerPlugin
  tui?: TuiPlugin<Renderer, Node>
  slots?: TuiSlotPlugin
}
