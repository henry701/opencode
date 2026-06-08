import { describe, expect, test } from "bun:test"
import { patchFiles } from "./apply-patch-file"
import { text } from "./session-diff"

describe("apply patch file", () => {
  test("parses patch metadata from the server", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        patch:
          "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(file?.view.fileDiff.name).toBe("a.ts")
    expect(file?.view.fileDiff.isPartial).toBe(false)
    expect(text(file!.view, "deletions")).toBe("one\ntwo\n")
    expect(text(file!.view, "additions")).toBe("one\nthree\n")
  })

  test("keeps legacy before and after payloads working", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        before: "one\n",
        after: "two\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(text(file!.view, "deletions")).toBe("one\n")
    expect(text(file!.view, "additions")).toBe("two\n")
  })

  test("accepts keyed file metadata from older tool results", () => {
    const file = patchFiles({
      "src/a.ts": {
        filePath: "/tmp/src/a.ts",
        relativePath: "src/a.ts",
        type: "update",
        patch:
          "Index: src/a.ts\n===================================================================\n--- src/a.ts\t\n+++ src/a.ts\t\n@@ -1 +1 @@\n-old\n+new\n",
        additions: 1,
        deletions: 1,
      },
    })[0]

    expect(file).toBeDefined()
    expect(file?.relativePath).toBe("src/a.ts")
    expect(text(file!.view, "deletions")).toBe("old\n")
    expect(text(file!.view, "additions")).toBe("new\n")
  })
})
