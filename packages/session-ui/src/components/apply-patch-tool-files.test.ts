import { describe, expect, test } from "bun:test"
import { applyPatchToolFiles } from "./apply-patch-tool-files"
import { text } from "./session-diff"

describe("applyPatchToolFiles", () => {
  test("adapts diff-only apply_patch metadata for rendering", () => {
    const file = applyPatchToolFiles({
      diff: "===================================================================\n--- /tmp/src/a.ts\t\n+++ /tmp/src/a.ts\t\n@@ -1 +1 @@\n-old\n+new\n",
    })[0]

    expect(file).toBeDefined()
    expect(file?.relativePath).toBe("tmp/src/a.ts")
    expect(text(file!.view, "deletions")).toBe("old\n")
    expect(text(file!.view, "additions")).toBe("new\n")
  })
})
