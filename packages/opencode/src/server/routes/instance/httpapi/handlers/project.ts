import * as InstanceState from "@/effect/instance-state"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@/project/project"
import { response } from "@opencode-ai/server/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProjectNotFoundError } from "../errors"
import { markInstanceForReload } from "../lifecycle"

export const projectHandlers = HttpApiBuilder.group(InstanceHttpApi, "project", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Project.Service
    const project = yield* ProjectV2.Service

    const list = Effect.fn("ProjectHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const listV2 = Effect.fn("ProjectHttpApi.listV2")(function* () {
      return yield* response(svc.list())
    })

    const current = Effect.fn("ProjectHttpApi.current")(function* () {
      return (yield* InstanceState.context).project
    })

    const currentV2 = Effect.fn("ProjectHttpApi.currentV2")(function* () {
      const location = yield* Location.Service
      const current = yield* svc.get(location.project.id)
      if (current) return yield* response(Effect.succeed(current))
      return yield* response(Effect.map(InstanceState.context, (ctx) => ctx.project))
    })

    const initGit = Effect.fn("ProjectHttpApi.initGit")(function* () {
      const ctx = yield* InstanceState.context
      const next = yield* svc.initGit({ directory: ctx.directory, project: ctx.project })
      if (next.id === ctx.project.id && next.vcs === ctx.project.vcs && next.worktree === ctx.project.worktree)
        return next
      yield* markInstanceForReload(ctx, {
        directory: ctx.directory,
        worktree: ctx.directory,
        project: next,
      })
      return next
    })

    const update = Effect.fn("ProjectHttpApi.update")(function* (ctx: {
      params: { projectID: ProjectV2.ID }
      payload: Project.UpdatePayload
    }) {
      return yield* svc.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
        Effect.catchTag("Project.NotFoundError", (error) =>
          Effect.fail(
            new ProjectNotFoundError({
              projectID: error.projectID,
              message: `Project not found: ${error.projectID}`,
            }),
          ),
        ),
      )
    })

    const directories = Effect.fn("ProjectHttpApi.directories")((ctx: { params: { projectID: ProjectV2.ID } }) =>
      project.directories({ projectID: ctx.params.projectID }),
    )

    const directoriesV2 = Effect.fn("ProjectHttpApi.directoriesV2")((ctx: { params: { projectID: ProjectV2.ID } }) =>
      response(project.directories({ projectID: ctx.params.projectID })),
    )

    return handlers
      .handle("list", list)
      .handle("listV2", listV2)
      .handle("current", current)
      .handle("currentV2", currentV2)
      .handle("initGit", initGit)
      .handle("update", update)
      .handle("directories", directories)
      .handle("directoriesV2", directoriesV2)
  }),
)
