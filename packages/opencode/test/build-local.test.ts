import { describe, expect, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/fixture"

const bootstrap = new URL("../../../script/local-bun.sh", import.meta.url).pathname
const linux = test.skipIf(process.platform !== "linux" || process.arch !== "x64")

async function fakeBun(dir: string, version: string) {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, "bun")
  await Bun.write(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
  await chmod(file, 0o755)
}

async function selectBun(dir: string, pin = "bun@1.3.14") {
  await Bun.write(path.join(dir, "package.json"), JSON.stringify({ packageManager: pin }))
  const child = Bun.spawn(["bash", "-euc", 'source "$1"; use_repo_bun "$2"; bun --version', "bash", bootstrap, dir], {
    cwd: "/tmp",
    env: {
      ...process.env,
      PATH: `${dir}/bin:${process.env.PATH}`,
      XDG_CACHE_HOME: path.join(dir, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

describe("build-local.sh", () => {
  test("regenerates the JavaScript SDK before building the local binary", async () => {
    const script = await Bun.file(new URL("../../../build-local.sh", import.meta.url)).text()
    const sdkBuild = script.indexOf("packages/sdk/js/script/build.ts")
    const opencodeBuild = script.indexOf("bun run script/build.ts --single --skip-install")

    expect(sdkBuild).toBeGreaterThan(0)
    expect(opencodeBuild).toBeGreaterThan(0)
    expect(sdkBuild).toBeLessThan(opencodeBuild)
  })

  linux("uses the system Bun when it matches the repository pin", async () => {
    await using tmp = await tmpdir()
    await fakeBun(path.join(tmp.path, "bin"), "1.3.14")
    const result = await selectBun(tmp.path)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("1.3.14")
  })

  linux("keeps using the repository pin after a system Bun upgrade", async () => {
    await using tmp = await tmpdir()
    await fakeBun(path.join(tmp.path, "bin"), "1.4.0")
    await fakeBun(path.join(tmp.path, "cache/opencode-local/bun/1.3.14/bin"), "1.3.14")
    const result = await selectBun(tmp.path)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("1.3.14")
  })

  linux("follows a changed repository pin rather than a hardcoded version", async () => {
    await using tmp = await tmpdir()
    await fakeBun(path.join(tmp.path, "bin"), "1.4.0")
    await fakeBun(path.join(tmp.path, "cache/opencode-local/bun/1.3.15/bin"), "1.3.15")
    const result = await selectBun(tmp.path, "bun@1.3.15")
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("1.3.15")
  })

  linux("stops the build when the pinned runtime cannot be downloaded", async () => {
    await using tmp = await tmpdir()
    await fakeBun(path.join(tmp.path, "bin"), "1.4.0")
    const curl = path.join(tmp.path, "bin/curl")
    await Bun.write(curl, "#!/bin/sh\necho 'simulated network failure' >&2\nexit 28\n")
    await chmod(curl, 0o755)
    const result = await selectBun(tmp.path)
    expect(result.code).toBe(28)
    expect(result.stderr).toContain("simulated network failure")
    expect(result.stdout).not.toContain("1.4.0")
  })

  linux("rejects an unpinned package manager before resolving dependencies", async () => {
    await using tmp = await tmpdir()
    await fakeBun(path.join(tmp.path, "bin"), "1.4.0")
    const result = await selectBun(tmp.path, "bun@latest")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("must pin an exact Bun version")
  })
})
