import type { CliRenderer } from "@opentui/core"
import {
  type SlotMode,
  type TuiPluginInput,
  type TuiSlotContext,
  type TuiSlotMap,
  type TuiSlots,
} from "@opencode-ai/plugin/tui"
import { createSlot, createSolidSlotRegistry, type JSX, type SolidPlugin } from "@opentui/solid"
import { isRecord } from "@/util/record"

type SlotProps<K extends keyof TuiSlotMap> = {
  name: K
  mode?: SlotMode
  children?: JSX.Element
} & TuiSlotMap[K]

type Slot = <K extends keyof TuiSlotMap>(props: SlotProps<K>) => JSX.Element | null

export type InitInput = Omit<TuiPluginInput<CliRenderer, JSX.Element>, "slots">

function empty<K extends keyof TuiSlotMap>(_props: SlotProps<K>) {
  return null
}

let view: Slot = empty

export const Slot: Slot = (props) => view(props)

function isTuiSlotPlugin(value: unknown): value is SolidPlugin<TuiSlotMap, TuiSlotContext> {
  if (!isRecord(value)) return false
  if (typeof value.id !== "string") return false
  if (!isRecord(value.slots)) return false
  return true
}

export function getTuiSlotPlugin(value: unknown) {
  if (isTuiSlotPlugin(value)) return value
  if (!isRecord(value)) return
  if (!isTuiSlotPlugin(value.slots)) return
  return value.slots
}

export function setupSlots(input: InitInput): TuiSlots {
  const reg = createSolidSlotRegistry<TuiSlotMap, TuiSlotContext>(
    input.renderer,
    {
      theme: input.api.theme,
    },
    {
      onPluginError(event) {
        console.error("[tui.slot] plugin error", {
          plugin: event.pluginId,
          slot: event.slot,
          phase: event.phase,
          source: event.source,
          message: event.error.message,
        })
      },
    },
  )

  const slot = createSlot<TuiSlotMap, TuiSlotContext>(reg)
  view = (props) => slot(props)
  return {
    register(pluginSlot) {
      if (!isTuiSlotPlugin(pluginSlot)) return () => {}
      return reg.register(pluginSlot)
    },
  }
}
