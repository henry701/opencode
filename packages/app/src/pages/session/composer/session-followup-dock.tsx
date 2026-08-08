import { For, Show, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

export function SessionFollowupDock(props: {
  items: { id: string; text: string }[]
  sending?: string
  editingMessageID?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: false,
  })

  const editing = () => props.editingMessageID

  createEffect(() => {
    if (!editing()) return
    setStore("collapsed", false)
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const total = createMemo(() => props.items.length)
  const label = createMemo(() => language.plural("session.followupDock.summary", total()))
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <DockTray
      data-component="session-followup-dock"
      data-editing={editing() ? "true" : "false"}
      classList={{
        "shadow-[0_0_0_1px_var(--v2-border-border-focus)]": !!editing(),
      }}
      style={{
        "margin-bottom": "-0.875rem",
        "border-bottom-left-radius": 0,
        "border-bottom-right-radius": 0,
      }}
    >
      <div
        class="pl-3 pr-2 py-2 flex items-center gap-2"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          toggle()
        }}
      >
        <span class="shrink-0 text-13-medium text-text-strong cursor-default">{label()}</span>
        <Show when={editing()}>
          <span class="shrink-0 text-12-regular text-icon-info-active cursor-default">
            {language.t("session.followupDock.editing")}
          </span>
        </Show>
        <Show when={store.collapsed && preview()}>
          <span class="min-w-0 flex-1 truncate text-13-regular text-text-base cursor-default">{preview()}</span>
        </Show>
        <div class="ml-auto shrink-0">
          <IconButton
            data-collapsed={store.collapsed ? "true" : "false"}
            icon="chevron-down"
            size="normal"
            variant="ghost"
            style={{ transform: `rotate(${store.collapsed ? 180 : 0}deg)` }}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              toggle()
            }}
            aria-label={
              store.collapsed ? language.t("session.followupDock.expand") : language.t("session.followupDock.collapse")
            }
          />
        </div>
      </div>

      <Show when={store.collapsed}>
        <div class="h-5" aria-hidden="true" />
      </Show>

      <Show when={!store.collapsed}>
        <div class="px-3 pb-7 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">
          <For each={props.items}>
            {(item) => {
              const active = () => editing() === item.id
              return (
                <div
                  tabIndex={0}
                  classList={{
                    "flex items-center gap-2 min-w-0 py-1 px-1 -mx-1 rounded-md": true,
                    "bg-v2-background-bg-raised ring-1 ring-inset ring-[var(--v2-border-border-focus)]": active(),
                  }}
                  onKeyDown={(event) => {
                    if (!event.altKey || event.key !== "Delete") return
                    event.preventDefault()
                    event.stopPropagation()
                    props.onRemove(item.id)
                  }}
                >
                  <span
                    classList={{
                      "min-w-0 flex-1 text-13-regular": true,
                      "text-icon-info-active whitespace-pre-wrap break-words": active(),
                      "truncate text-text-strong": !active(),
                    }}
                  >
                    {item.text}
                  </span>
                  <Show
                    when={active()}
                    fallback={
                      <>
                        <Show when={!editing()}>
                          <Button
                            size="small"
                            variant="secondary"
                            class="shrink-0"
                            disabled={!!props.sending}
                            onClick={() => props.onSend(item.id)}
                          >
                            {language.t("session.followupDock.sendNow")}
                          </Button>
                        </Show>
                        <Button
                          size="small"
                          variant="ghost"
                          class="shrink-0"
                          disabled={!!props.sending || !!editing()}
                          onClick={() => props.onEdit(item.id)}
                        >
                          {language.t("session.followupDock.edit")}
                        </Button>
                        <IconButton
                          icon="trash"
                          size="normal"
                          variant="ghost"
                          class="shrink-0"
                          disabled={!!props.sending}
                          onClick={() => props.onRemove(item.id)}
                          aria-label={language.t("common.delete")}
                        />
                      </>
                    }
                  >
                    <>
                      <span class="shrink-0 text-12-medium text-icon-info-active">
                        {language.t("session.followupDock.editing")}
                      </span>
                      <IconButton
                        icon="trash"
                        size="normal"
                        variant="ghost"
                        class="shrink-0"
                        disabled={!!props.sending}
                        onClick={() => props.onRemove(item.id)}
                        aria-label={language.t("common.delete")}
                      />
                    </>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </DockTray>
  )
}
