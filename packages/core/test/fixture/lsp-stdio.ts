import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"

const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout))

connection.onRequest("initialize", () => ({ capabilities: { textDocumentSync: 1, definitionProvider: true } }))
connection.onNotification("initialized", () => {})
connection.onNotification("textDocument/didOpen", (input: { textDocument: { uri: string } }) => {
  connection.sendNotification("textDocument/publishDiagnostics", {
    uri: input.textDocument.uri,
    diagnostics: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 1,
        source: "fixture",
        message: "fixture diagnostic",
      },
    ],
  })
})
connection.onNotification("textDocument/didChange", (input: { textDocument: { uri: string } }) => {
  connection.sendNotification("textDocument/publishDiagnostics", {
    uri: input.textDocument.uri,
    diagnostics: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 1,
        source: "fixture",
        message: "fixture diagnostic",
      },
    ],
  })
})
connection.onRequest("textDocument/definition", (input: { textDocument: { uri: string } }) => [
  { uri: input.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
])
connection.onRequest("shutdown", () => null)
connection.onNotification("exit", () => process.exit(0))
connection.listen()
