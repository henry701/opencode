import { describe, expect, test } from "bun:test"

describe("build-local.sh", () => {
  test("regenerates the JavaScript SDK before building the local binary", async () => {
    const script = await Bun.file(new URL("../../../build-local.sh", import.meta.url)).text()
    const sdkBuild = script.indexOf("packages/sdk/js/script/build.ts")
    const opencodeBuild = script.indexOf("bun run script/build.ts --single --skip-install")

    expect(sdkBuild).toBeGreaterThan(0)
    expect(opencodeBuild).toBeGreaterThan(0)
    expect(sdkBuild).toBeLessThan(opencodeBuild)
  })
})
