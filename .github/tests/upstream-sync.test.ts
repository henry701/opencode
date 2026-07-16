import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const workflowPath = path.join(import.meta.dir, "../workflows/upstream-sync.yml")
const source = await Bun.file(workflowPath).text()
const workflow = Bun.YAML.parse(source) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: {
    sync: {
      if: string
      environment: string
      permissions: Record<string, string>
      strategy: { matrix: { branch: string[] } }
      steps: Array<{
        id?: string
        uses?: string
        if?: string
        env?: Record<string, string>
        with?: Record<string, string | boolean>
        run?: string
      }>
    }
  }
}

const job = workflow.jobs.sync
const step = (id: string) => job.steps.find((item) => item.id === id)

async function command(cwd: string, args: string[], env?: Record<string, string>) {
  const process = Bun.spawn(args, {
    cwd,
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function git(cwd: string, ...args: string[]) {
  const result = await command(cwd, ["git", ...args])
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "upstream-sync-test-"))
  const runner = await mkdtemp(path.join(os.tmpdir(), "upstream-sync-runner-"))
  const output = path.join(runner, "output")
  await git(root, "init", "-b", "dev")
  await git(root, "config", "user.name", "Test")
  await git(root, "config", "user.email", "test@example.com")
  await writeFile(path.join(root, "conflict.txt"), "base\n")
  await writeFile(path.join(root, "stable.txt"), "stable\n")
  await git(root, "add", ".")
  await git(root, "commit", "-m", "base")
  await git(root, "switch", "-c", "upstream-work")
  await writeFile(path.join(root, "conflict.txt"), "upstream pattern\n")
  await git(root, "commit", "-am", "upstream change")
  const upstream = await git(root, "rev-parse", "HEAD")
  await git(root, "switch", "dev")
  await writeFile(path.join(root, "conflict.txt"), "fork feature\n")
  await git(root, "commit", "-am", "fork feature")
  await git(root, "update-ref", "refs/remotes/upstream/dev", upstream)

  const merge = await command(root, ["bash", "-euo", "pipefail", "-c", step("merge")!.run!], {
    GITHUB_OUTPUT: output,
    RUNNER_TEMP: runner,
    TARGET_BRANCH: "dev",
  })
  expect(merge.exitCode).toBe(0)
  expect(await Bun.file(output).text()).toContain("status=conflict")
  return { root, runner, upstream }
}

describe("upstream sync security boundary", () => {
  test("only runs trusted events from the fork's long-lived branches", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"])
    expect(workflow.permissions).toEqual({})
    expect(job.if).toContain("github.repository == 'henry701/opencode'")
    expect(job.if).toContain("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'")
    expect(job.if).toContain("github.ref == 'refs/heads/production' || github.ref == 'refs/heads/dev'")
    expect(job.strategy.matrix.branch).toEqual(["production", "dev"])
    expect(job.environment).toBe("upstream-sync")
    expect(job.permissions).toEqual({ contents: "write" })
  })

  test("pins actions and keeps the repository token away from Codex", () => {
    const checkout = job.steps.find((item) => item.uses?.startsWith("actions/checkout@"))
    const codex = step("codex")

    expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/)
    expect(checkout?.with?.["persist-credentials"]).toBe(false)
    expect(codex?.uses).toMatch(/^openai\/codex-action@[0-9a-f]{40}$/)
    expect(codex?.if).toBe("steps.merge.outputs.status == 'conflict' && steps.merge.outputs.safe == 'true'")
    expect(codex?.with?.["openai-api-key"]).toBe("${{ secrets.OPENAI_API_KEY }}")
    expect(codex?.with?.model).toBe("gpt-5.6-terra")
    expect(codex?.with?.effort).toBe("medium")
    expect(codex?.with?.["permission-profile"]).toBe(":workspace")
    expect(codex?.with?.["safety-strategy"]).toBe("drop-sudo")
    expect(codex?.with?.["codex-args"]).toContain("--ignore-rules")
    expect(codex?.with?.["codex-args"]).toContain("project_doc_max_bytes=0")
    expect(codex?.with?.["codex-version"]).toMatch(/^\d+\.\d+\.\d+$/)
    expect(codex?.env?.GIT_OPTIONAL_LOCKS).toBe("0")
    expect(job.steps.filter((item) => !item.uses && item.env?.OPENAI_API_KEY)).toEqual([])
  })

  test("retains conflicts for Codex and validates its edits before pushing", () => {
    expect(step("merge")?.run).not.toContain("git merge --abort")
    expect(step("merge")?.run).toContain("$RUNNER_TEMP/upstream-sync-conflicts")
    expect(step("merge")?.run).toContain('if [[ ! -s "$RUNNER_TEMP/upstream-sync-conflicts" ]]')
    expect(step("merge")?.run).toContain("Merge failed without unresolved conflict paths")
    expect(step("merge")?.run).toContain("tar --sort=name")

    const validate = step("validate")
    expect(validate?.if).toBe("steps.codex.outcome == 'success'")
    expect(validate?.run).toContain("git diff --name-only --diff-filter=U")
    expect(validate?.run).toContain("git diff --check")
    expect(validate?.run).toContain("Unexpected Codex edit outside the conflict set")
    expect(validate?.run).toContain("Codex changed the index.")
    expect(validate?.run).toContain("Codex changed git metadata.")

    const push = step("push")
    expect(push?.run).toContain('git -c core.hooksPath=/dev/null push origin "HEAD:$TARGET_BRANCH"')
  })

  test("accepts a conflict-only resolution and creates the merge commit", async () => {
    const test = await fixture()
    try {
      await writeFile(path.join(test.root, "conflict.txt"), "upstream pattern with fork feature\n")
      const result = await command(test.root, ["bash", "-euo", "pipefail", "-c", step("validate")!.run!], {
        RUNNER_TEMP: test.runner,
        TARGET_BRANCH: "dev",
        UPSTREAM_HASH: test.upstream,
      })

      expect(result.stderr).toBe("")
      expect(result.exitCode).toBe(0)
      expect(await git(test.root, "rev-list", "--parents", "-n", "1", "HEAD")).toMatch(
        /^[0-9a-f]{40} [0-9a-f]{40} [0-9a-f]{40}$/,
      )
    } finally {
      await Promise.all([
        rm(test.root, { recursive: true, force: true }),
        rm(test.runner, { recursive: true, force: true }),
      ])
    }
  })

  test("rejects a staged edit outside the original conflict set", async () => {
    const test = await fixture()
    try {
      await writeFile(path.join(test.root, "conflict.txt"), "upstream pattern with fork feature\n")
      await writeFile(path.join(test.root, "stable.txt"), "unexpected\n")
      await git(test.root, "add", "stable.txt")
      const result = await command(test.root, ["bash", "-euo", "pipefail", "-c", step("validate")!.run!], {
        RUNNER_TEMP: test.runner,
        TARGET_BRANCH: "dev",
        UPSTREAM_HASH: test.upstream,
      })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Codex changed the index.")
    } finally {
      await Promise.all([
        rm(test.root, { recursive: true, force: true }),
        rm(test.runner, { recursive: true, force: true }),
      ])
    }
  })

  test("rejects a git hook added after the merge", async () => {
    const test = await fixture()
    try {
      await writeFile(path.join(test.root, "conflict.txt"), "upstream pattern with fork feature\n")
      await symlink("/bin/true", path.join(test.root, ".git/hooks/pre-push"))
      const result = await command(test.root, ["bash", "-euo", "pipefail", "-c", step("validate")!.run!], {
        RUNNER_TEMP: test.runner,
        TARGET_BRANCH: "dev",
        UPSTREAM_HASH: test.upstream,
      })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Codex changed git metadata.")
    } finally {
      await Promise.all([
        rm(test.root, { recursive: true, force: true }),
        rm(test.runner, { recursive: true, force: true }),
      ])
    }
  })
})
