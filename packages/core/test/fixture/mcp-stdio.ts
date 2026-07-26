import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { GetPromptRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "core-mcp-stdio-test", version: "1.0.0" }, { capabilities: { prompts: {} } })

server.setRequestHandler(ListPromptsRequestSchema, () =>
  Promise.resolve({
    prompts: [{ name: "cwd", arguments: [{ name: "suffix" }] }],
  }),
)
server.setRequestHandler(GetPromptRequestSchema, (request) =>
  Promise.resolve({
    messages: [
      {
        role: "user",
        content: { type: "text", text: `${process.cwd()}/${request.params.arguments?.suffix ?? ""}` },
      },
    ],
  }),
)

await server.connect(new StdioServerTransport())
