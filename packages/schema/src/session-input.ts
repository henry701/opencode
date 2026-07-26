export * as SessionInput from "./session-input"

import { Schema } from "effect"
import { optional } from "./schema"
import { Prompt } from "./prompt"
import { DateTimeUtcFromMillis, NonNegativeInt } from "./schema"
import { SessionDelivery } from "./session-delivery"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"
import { SessionInputPayload } from "./session-input-payload"

export const Delivery = SessionDelivery.Delivery
export type Delivery = SessionDelivery.Delivery

export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
export const Admitted = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionID,
  prompt: Prompt,
  payload: SessionInputPayload.Payload.pipe(optional),
  delivery: Delivery,
  timeCreated: DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(optional),
  updatedSeq: NonNegativeInt.pipe(optional),
  discardedSeq: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionInput.Admitted" })

export interface Queued extends Schema.Schema.Type<typeof Queued> {}
export const Queued = Schema.Struct({
  id: SessionMessage.ID,
  sessionID: SessionID,
  position: NonNegativeInt,
  timeCreated: DateTimeUtcFromMillis,
  payload: SessionInputPayload.Payload,
}).annotate({ identifier: "SessionInput.Queued" })

export const QueuePreview = Schema.Struct({
  id: SessionMessage.ID,
  position: NonNegativeInt,
  text: Schema.String,
}).annotate({ identifier: "SessionInput.QueuePreview" })
export interface QueuePreview extends Schema.Schema.Type<typeof QueuePreview> {}
