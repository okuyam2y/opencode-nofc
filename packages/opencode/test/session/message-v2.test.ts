import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform } from "../../src/provider"
import type { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Question } from "../../src/question"

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("test")
const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelID.make("test") },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: MessageV2.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): MessageV2.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id),
    sessionID,
    messageID: MessageID.make(messageID),
  }
}

describe("session.message-v2.toModelMessage", () => {
  test("filters out messages with no parts", async () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("filters out messages with only ignored parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes synthetic text parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("converts user text/file parts and injects compaction/subtask prompts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          { type: "text", text: "What did we do so far?" },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("preserves jpeg tool-result media for anthropic models", async () => {
    const anthropicModel: Provider.Model = {
      ...model,
      id: ModelID.make("anthropic/claude-opus-4-7"),
      providerID: ProviderID.make("anthropic"),
      api: {
        id: "claude-opus-4-7-20250805",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
          pdf: true,
        },
      },
    }
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString(
      "base64",
    )
    const userID = "m-user-anthropic"
    const assistantID = "m-assistant-anthropic"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-anthropic"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-anthropic"),
            type: "tool",
            callID: "call-anthropic-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/rails-demo.png" },
              output: "Image read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-anthropic-1"),
                  type: "file",
                  mime: "image/jpeg",
                  filename: "rails-demo.png",
                  url: `data:image/jpeg;base64,${jpeg}`,
                },
              ],
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = ProviderTransform.message(await MessageV2.toModelMessages(input, anthropicModel), anthropicModel, {})
    expect(result).toHaveLength(3)
    expect(result[2].role).toBe("tool")
    expect(result[2].content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-anthropic-1",
      toolName: "read",
      output: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "media", mediaType: "image/jpeg", data: jpeg },
        ],
      },
    })
  })

  test("omits provider metadata when assistant model differs", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("replaces compacted tool output with placeholder", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[Old tool result content cleared]" },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("forwards partial bash output for aborted tool calls", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const output = [
      "31403",
      "12179",
      "4575",
      "",
      "<bash_metadata>",
      "User aborted the command",
      "</bash_metadata>",
    ].join("\n")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
              error: "Tool execution aborted",
              metadata: { interrupted: true, output },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: output },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", async () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"]

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })

  test("prepends soft failure signal for non-zero exit code", async () => {
    const userID = MessageID.make("u-soft")
    const assistantID = MessageID.make("a-soft")
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "t1"),
            type: "tool",
            callID: "call-bash",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "exit 1" },
              output: "test failed",
              title: "Bash",
              metadata: { exit: 1 },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const toolResult = (toolMsg as any).content[0]
    expect(toolResult.output).toStrictEqual({
      type: "text",
      value: "[exit_code=1]\ntest failed",
    })
  })

  test("does not prepend soft failure signal for zero exit code", async () => {
    const userID = MessageID.make("u-ok")
    const assistantID = MessageID.make("a-ok")
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "t2"),
            type: "tool",
            callID: "call-bash-ok",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "echo hi" },
              output: "hi",
              title: "Bash",
              metadata: { exit: 0 },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const toolResult = (toolMsg as any).content[0]
    expect(toolResult.output).toStrictEqual({
      type: "text",
      value: "hi",
    })
  })

  test("does not prepend soft failure signal for compacted tool result", async () => {
    const userID = MessageID.make("u-compact")
    const assistantID = MessageID.make("a-compact")
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "t3"),
            type: "tool",
            callID: "call-compact",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "exit 1" },
              output: "test failed",
              title: "Bash",
              metadata: { exit: 1 },
              time: { start: 0, end: 1, compacted: 2 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const toolResult = (toolMsg as any).content[0]
    expect(toolResult.output).toStrictEqual({
      type: "text",
      value: "[Old tool result content cleared]",
    })
  })
})

describe("session.message-v2.fromError", () => {
  test("serializes context_length_exceeded as ContextOverflowError", () => {
    const input = {
      type: "error",
      error: {
        code: "context_length_exceeded",
      },
    }
    const result = MessageV2.fromError(input, { providerID })

    expect(result).toStrictEqual({
      name: "ContextOverflowError",
      data: {
        message: "Input exceeds context window of this model",
        responseBody: JSON.stringify(input),
      },
    })
  })

  test("serializes response error codes", () => {
    const cases = [
      {
        code: "insufficient_quota",
        message: "Quota exceeded. Check your plan and billing details.",
      },
      {
        code: "usage_not_included",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
      },
      {
        code: "invalid_prompt",
        message: "Invalid prompt from test",
      },
    ]

    cases.forEach((item) => {
      const input = {
        type: "error",
        error: {
          code: item.code,
          message: item.code === "invalid_prompt" ? item.message : undefined,
        },
      }
      const result = MessageV2.fromError(input, { providerID })

      expect(result).toStrictEqual({
        name: "APIError",
        data: {
          message: item.message,
          isRetryable: false,
          responseBody: JSON.stringify(input),
        },
      })
    })
  })

  test("detects context overflow from APICallError provider messages", () => {
    const cases = [
      "prompt is too long: 213462 tokens > 200000 maximum",
      "Your input exceeds the context window of this model",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
      "Please reduce the length of the messages or completion",
      "400 status code (no body)",
      "413 status code (no body)",
    ]

    cases.forEach((message) => {
      const error = new APICallError({
        message,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 400,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      })
      const result = MessageV2.fromError(error, { providerID })
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })
  })

  test("detects context overflow from context_length_exceeded code in response body", () => {
    const error = new APICallError({
      message: "Request failed",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 422,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        error: {
          message: "Some message",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
  })

  test("does not classify 429 no body as context overflow", () => {
    const result = MessageV2.fromError(
      new APICallError({
        message: "429 status code (no body)",
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      }),
      { providerID },
    )
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(false)
    expect(MessageV2.APIError.isInstance(result)).toBe(true)
  })

  test("serializes unknown inputs", () => {
    const result = MessageV2.fromError(123, { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "123",
      },
    })
  })

  test("serializes tagged errors with their message", () => {
    const result = MessageV2.fromError(new Question.RejectedError(), { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "The user dismissed this question",
      },
    })
  })

  test("classifies ZlibError from fetch as retryable APIError", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0
    ;(zlibError as any).path = ""

    const result = MessageV2.fromError(zlibError, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect((result as MessageV2.APIError).data.message).toInclude("decompression")
  })

  test("classifies ZlibError as AbortedError when abort context is provided", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0

    const result = MessageV2.fromError(zlibError, { providerID, aborted: true })

    expect(result.name).toBe("MessageAbortedError")
  })

  test("skips tool parts with metadata.notFound in toModelMessages", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "read file",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "error",
              input: { file_path: "/nonexistent.ts" },
              error: "File not found: /nonexistent.ts",
              time: { start: 0, end: 1 },
            },
            metadata: { notFound: true },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    // The tool result should be replaced with a minimal "[File does not exist]"
    // message — no file path, no details to fabricate from.
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const toolResult = (toolMsg as any).content[0]
    expect(toolResult.output.value).toBe("[File does not exist — use glob to search for the correct path]")
    // Input should be empty or absent (path stripped)
    expect(toolResult.input ?? {}).toStrictEqual({})
  })

  test("does NOT skip tool error parts without notFound metadata", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "read file",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "error",
              input: { file_path: "/nonexistent.ts" },
              error: "File not found: /nonexistent.ts",
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    // Without notFound metadata, the error tool result should be present
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    expect((toolMsg as any).content[0].output.value).toBe("File not found: /nonexistent.ts")
  })

  test("pendingDirectives: prepends directive to hermes notFound fixed text", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const toolPartID = PartID.make("a1")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          { ...basePart(userID, "u1"), type: "text", text: "read file" },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            id: toolPartID,
            sessionID,
            messageID: MessageID.make(assistantID),
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "error",
              input: { filePath: "/a.ts" },
              error: "File not found: /a.ts",
              time: { start: 0, end: 1 },
            },
            metadata: { notFound: true },
          },
        ] as MessageV2.Part[],
      },
    ]

    const pending = new Map<string, string>([[toolPartID, "[RESET: stop guessing]"]])
    const result = await MessageV2.toModelMessages(input, model, { pendingDirectives: pending })
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const value: string = (toolMsg as any).content[0].output.value
    expect(value.startsWith("[RESET: stop guessing]\n\n")).toBe(true)
    expect(value).toContain("[File does not exist — use glob to search for the correct path]")
  })

  test("pendingDirectives: prepends directive to normal error text", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const toolPartID = PartID.make("a1")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          { ...basePart(userID, "u1"), type: "text", text: "grep foo" },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            id: toolPartID,
            sessionID,
            messageID: MessageID.make(assistantID),
            type: "tool",
            callID: "call-1",
            tool: "grep",
            state: {
              status: "error",
              input: { pattern: "foo" },
              error: "ripgrep failed with exit 2",
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const pending = new Map<string, string>([[toolPartID, "[RESET: strategy change]"]])
    const result = await MessageV2.toModelMessages(input, model, { pendingDirectives: pending })
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const value: string = (toolMsg as any).content[0].output.value
    expect(value.startsWith("[RESET: strategy change]\n\n---\n")).toBe(true)
    expect(value).toContain("ripgrep failed with exit 2")
  })

  test("pendingDirectives: unaffected when partID is absent from the map", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const toolPartID = PartID.make("a1")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          { ...basePart(userID, "u1"), type: "text", text: "grep foo" },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            id: toolPartID,
            sessionID,
            messageID: MessageID.make(assistantID),
            type: "tool",
            callID: "call-1",
            tool: "grep",
            state: {
              status: "error",
              input: { pattern: "foo" },
              error: "ripgrep failed with exit 2",
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    // Map is present but keyed on a different part ID — must not touch the error.
    const pending = new Map<string, string>([[PartID.make("other"), "[RESET]"]])
    const result = await MessageV2.toModelMessages(input, model, { pendingDirectives: pending })
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    expect((toolMsg as any).content[0].output.value).toBe("ripgrep failed with exit 2")
  })

  test("providerMeta drops internal flags from callProviderMetadata on hermes notFound path", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const toolPartID = PartID.make("a1")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          { ...basePart(userID, "u1"), type: "text", text: "grep foo" },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            id: toolPartID,
            sessionID,
            messageID: MessageID.make(assistantID),
            type: "tool",
            callID: "call-1",
            tool: "grep",
            state: {
              status: "error",
              input: { pattern: "foo" },
              error: "boom",
              time: { start: 0, end: 1 },
            },
            // Internal flags that providerMeta() must strip + a passthrough
            // field that must survive.  We deliberately do NOT set
            // providerExecuted here — that flag re-routes the part as a
            // provider-executed call and suppresses the tool-role message
            // convertToModelMessages emits.  In practice hermes notFound and
            // providerExecuted don't co-occur (hermes means local execution).
            metadata: {
              notFound: true,
              resetDirective: "should never reach provider",
              customPassthrough: "keep-me",
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const resultItem = (toolMsg as any).content[0]
    // Fixed-text rewrite confirms metadata.notFound was honored.
    const value: string = resultItem.output.value
    expect(value).toBe("[File does not exist — use glob to search for the correct path]")
    // providerMeta() behavior: internal flags stripped from callProviderMetadata,
    // passthrough field preserved.  Without asserting on providerOptions the
    // test would still pass if providerMeta() were a no-op, so this is the
    // load-bearing assertion.
    expect(resultItem.providerOptions).toEqual({ customPassthrough: "keep-me" })
  })

  test("providerMeta forwards passthrough metadata on hermes notFound rewrite", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const toolPartID = PartID.make("a1")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          { ...basePart(userID, "u1"), type: "text", text: "read file" },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            id: toolPartID,
            sessionID,
            messageID: MessageID.make(assistantID),
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "error",
              input: { filePath: "/a.ts" },
              error: "File not found: /a.ts",
              time: { start: 0, end: 1 },
            },
            metadata: {
              notFound: true,
              // providerExecuted intentionally omitted — see the companion test
              // above: the flag re-routes convertToModelMessages output.
              //
              // Passthrough field — must survive the hermes rewrite.
              anthropicCacheControl: { type: "ephemeral" },
              // Internal-only — must be stripped by providerMeta.
              resetDirective: "internal",
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const resultItem = (toolMsg as any).content[0]
    // Fixed text still emitted by the notFound rewrite.
    expect(resultItem.output.value).toBe(
      "[File does not exist — use glob to search for the correct path]",
    )
    // Passthrough metadata survives, internal flags dropped.
    expect(resultItem.providerOptions).toEqual({ anthropicCacheControl: { type: "ephemeral" } })
  })

  test("hermes notFound + providerExecuted: internal flags stripped, passthrough metadata preserved", async () => {
    // Regression guard for the rev.6 hermes-branch spread of providerExecuted +
    // callProviderMetadata.  In practice this combination does not occur —
    // hermes means local tool execution, while providerExecuted=true signals a
    // provider-side tool.  But if it ever does, we must (a) not crash, (b) pass
    // provider metadata through via providerMeta() (stripping internal flags),
    // and (c) preserve the provider-executed routing.  The AI SDK's
    // convertToModelMessages emits only a `tool-call` on the assistant message
    // for provider-executed parts (the provider supplies its own result), so
    // we can't assert the hermes fixed text here — only that the passthrough
    // and strip invariants hold.
    const userID = "m-user"
    const assistantID = "m-assistant"
    const toolPartID = PartID.make("a1")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          { ...basePart(userID, "u1"), type: "text", text: "read file" },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            id: toolPartID,
            sessionID,
            messageID: MessageID.make(assistantID),
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "error",
              input: { filePath: "/a.ts" },
              error: "File not found: /a.ts",
              time: { start: 0, end: 1 },
            },
            metadata: {
              notFound: true,
              providerExecuted: true,
              anthropicCacheControl: { type: "ephemeral" },
              resetDirective: "internal",
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    const assistant = result.find((m) => m.role === "assistant")
    expect(assistant).toBeDefined()
    const toolCall = (assistant as any).content.find((c: any) => c.type === "tool-call")
    expect(toolCall).toBeDefined()
    // Provider-executed routing preserved.
    expect(toolCall.providerExecuted).toBe(true)
    // Passthrough provider metadata survives.
    expect(toolCall.providerOptions).toEqual({ anthropicCacheControl: { type: "ephemeral" } })
    // Branch-distinguishing assertion: the hermes `notFound` rewrite sets
    // `input: {}` (no filePath exposed to the model), whereas the normal error
    // path preserves `part.state.input`.  Asserting `{}` here proves the
    // notFound branch actually ran instead of falling through.
    expect(toolCall.input).toEqual({})
    // Internal flags must not leak anywhere in the serialized output.
    const blob = JSON.stringify(result)
    expect(blob).not.toContain("resetDirective")
    expect(blob).not.toContain('"notFound"')
  })

  test("providerMeta forwards non-internal metadata on normal error path", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const toolPartID = PartID.make("a1")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          { ...basePart(userID, "u1"), type: "text", text: "grep foo" },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            id: toolPartID,
            sessionID,
            messageID: MessageID.make(assistantID),
            type: "tool",
            callID: "call-1",
            tool: "grep",
            state: {
              status: "error",
              input: { pattern: "foo" },
              error: "boom",
              time: { start: 0, end: 1 },
            },
            metadata: {
              // Must be stripped:
              notFound: false,      // not === true, so no hermes rewrite
              resetDirective: "internal",
              providerExecuted: false,
              // Must survive:
              anthropicCacheControl: { type: "ephemeral" },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    const resultItem = (toolMsg as any).content[0]
    // callProviderMetadata lands on the tool-result's providerOptions
    const opts = resultItem.providerOptions
    expect(opts).toEqual({ anthropicCacheControl: { type: "ephemeral" } })
  })
})

describe("MessageV2.StreamRetryableError dispatch", () => {
  test("fromError wraps StreamRetryableError as retryable APIError", () => {
    const e = new MessageV2.StreamRetryableError(502, "gateway 5xx")
    const result = MessageV2.fromError(e, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (MessageV2.APIError.isInstance(result)) {
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.statusCode).toBe(502)
      expect(result.data.message).toBe("gateway 5xx")
    }
  })

  test("fromError with forceNonRetryable stamps both isRetryable=false and nonRetryable=true on APIError", () => {
    // A 5xx error that would normally be retryable, but because a tool already
    // executed in this attempt we must not retry (to avoid re-executing side
    // effects). nonRetryable is the hard veto that wins over retry.ts's 5xx
    // force-retry escape hatch (which would otherwise retry on isRetryable=false alone).
    const e = new MessageV2.StreamRetryableError(503, "service unavailable")
    const result = MessageV2.fromError(e, { providerID, forceNonRetryable: true })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (MessageV2.APIError.isInstance(result)) {
      expect(result.data.isRetryable).toBe(false)
      expect(result.data.nonRetryable).toBe(true)
      expect(result.data.statusCode).toBe(503)
    }
  })

  test("fromError without forceNonRetryable keeps isRetryable=true and leaves nonRetryable unset", () => {
    const e = new MessageV2.StreamRetryableError(500, "internal error")
    const result = MessageV2.fromError(e, { providerID, forceNonRetryable: false })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (MessageV2.APIError.isInstance(result)) {
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.nonRetryable).toBeUndefined()
    }
  })

  test("forceNonRetryable does not convert non-APIError results", () => {
    // An APICallError that ProviderError.parseAPICallError classifies as non-retryable
    // should stay non-retryable without any wrapper interference.
    const abortErr = new DOMException("aborted", "AbortError")
    const result = MessageV2.fromError(abortErr, { providerID, forceNonRetryable: true })

    // AbortError maps to AbortedError, not APIError — forceNonRetryable must pass through.
    expect(MessageV2.AbortedError.isInstance(result)).toBe(true)
  })
})

describe("MessageV2.extractStatusCode", () => {
  test("reads status from top-level error object", () => {
    expect(MessageV2.extractStatusCode({ status: 429 })).toBe(429)
    expect(MessageV2.extractStatusCode({ statusCode: 500 })).toBe(500)
  })

  test("reads status from JSON-encoded message", () => {
    const err = { message: JSON.stringify({ status: 502 }) }
    expect(MessageV2.extractStatusCode(err)).toBe(502)
  })

  test("returns undefined for non-object", () => {
    expect(MessageV2.extractStatusCode(null)).toBeUndefined()
    expect(MessageV2.extractStatusCode("oops")).toBeUndefined()
    expect(MessageV2.extractStatusCode(undefined)).toBeUndefined()
  })

  test("returns undefined for plain object without status", () => {
    expect(MessageV2.extractStatusCode({ message: "no code here" })).toBeUndefined()
  })
})

describe("MessageV2.isContentFilter", () => {
  test("detects content filter markers in direct message", () => {
    expect(MessageV2.isContentFilter({ message: "content management policy violated" })).toBe(true)
    expect(MessageV2.isContentFilter({ message: "response was filtered by Azure" })).toBe(true)
    expect(MessageV2.isContentFilter({ message: "content_filter: policy" })).toBe(true)
  })

  test("detects content filter markers in nested error", () => {
    const err = { error: { message: "content filtering triggered" } }
    expect(MessageV2.isContentFilter(err)).toBe(true)
  })

  test("returns false for unrelated errors", () => {
    expect(MessageV2.isContentFilter({ message: "internal server error" })).toBe(false)
    expect(MessageV2.isContentFilter({ message: "connection refused" })).toBe(false)
  })

  test("handles strings and non-objects", () => {
    expect(MessageV2.isContentFilter("content_filter hit")).toBe(true)
    expect(MessageV2.isContentFilter("plain network failure")).toBe(false)
    expect(MessageV2.isContentFilter(null)).toBe(false)
  })
})

describe("MessageV2.extractConnectionErrorCode", () => {
  test("reads code from data.metadata.code (AI SDK APIError JSON shape)", () => {
    // Real shape captured in stress-test (docs/investigations/stress-test/logs/A/run-1.out)
    const part = {
      name: "APIError",
      data: {
        message: "Connection reset by server",
        isRetryable: false,
        metadata: { code: "ECONNRESET", syscall: "", message: "The socket connection was closed unexpectedly" },
      },
    }
    expect(MessageV2.extractConnectionErrorCode(part)).toBe("ECONNRESET")
  })

  test("reads code from metadata.code, top-level code, and cause.code", () => {
    expect(MessageV2.extractConnectionErrorCode({ metadata: { code: "EPIPE" } })).toBe("EPIPE")
    expect(MessageV2.extractConnectionErrorCode({ code: "ETIMEDOUT" })).toBe("ETIMEDOUT")
    expect(MessageV2.extractConnectionErrorCode({ cause: { code: "UND_ERR_SOCKET" } })).toBe("UND_ERR_SOCKET")
  })

  test("returns undefined for non-connection codes (ECONNREFUSED is intentional)", () => {
    // ECONNREFUSED is permanent (gateway unreachable), not transient — must not be auto-retried.
    expect(MessageV2.extractConnectionErrorCode({ code: "ECONNREFUSED" })).toBeUndefined()
    expect(MessageV2.extractConnectionErrorCode({ data: { metadata: { code: "ENOTFOUND" } } })).toBeUndefined()
    expect(MessageV2.extractConnectionErrorCode({ code: 500 })).toBeUndefined() // numeric, not a code
    expect(MessageV2.extractConnectionErrorCode(null)).toBeUndefined()
    expect(MessageV2.extractConnectionErrorCode("ECONNRESET")).toBeUndefined() // string, not object
  })
})

describe("MessageV2.StreamRetryableError without statusCode (connection errors)", () => {
  test("fromError accepts undefined statusCode and produces retryable APIError", () => {
    const e = new MessageV2.StreamRetryableError(undefined, "Connection reset by server")
    const result = MessageV2.fromError(e, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (MessageV2.APIError.isInstance(result)) {
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.statusCode).toBeUndefined()
      expect(result.data.message).toBe("Connection reset by server")
    }
  })

  test("forceNonRetryable stamps the veto on connection-error APIError too", () => {
    // After tool execution, even a transient ECONNRESET must not retry — it would
    // re-execute side effects. nonRetryable=true is the hard veto.
    const e = new MessageV2.StreamRetryableError(undefined, "ECONNRESET")
    const result = MessageV2.fromError(e, { providerID, forceNonRetryable: true })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (MessageV2.APIError.isInstance(result)) {
      expect(result.data.isRetryable).toBe(false)
      expect(result.data.nonRetryable).toBe(true)
      expect(result.data.statusCode).toBeUndefined()
    }
  })
})

describe("MessageV2.tryEscalateStreamError", () => {
  test("escalates ECONNRESET error part with the real observed payload", () => {
    // Captured from docs/investigations/stress-test/logs/A/run-1.out:32 — the exact
    // shape the AI SDK emits when the gateway resets the socket mid-stream.
    const part = {
      type: "error" as const,
      error: {
        name: "APIError",
        data: {
          message: "Connection reset by server",
          isRetryable: false,
          metadata: {
            code: "ECONNRESET",
            syscall: "",
            message: "The socket connection was closed unexpectedly",
          },
        },
      },
    }
    const escalated = MessageV2.tryEscalateStreamError(part)
    expect(escalated).toBeInstanceOf(MessageV2.StreamRetryableError)
    expect(escalated?.statusCode).toBeUndefined()
    expect(escalated?.message).toBe("Connection reset by server")
    expect(escalated?.cause).toBe(part.error)
  })

  test("escalates 5xx error parts (preserves prior 5xx behavior)", () => {
    const part = { type: "error" as const, error: { statusCode: 503, message: "service unavailable" } }
    const escalated = MessageV2.tryEscalateStreamError(part)
    expect(escalated).toBeInstanceOf(MessageV2.StreamRetryableError)
    expect(escalated?.statusCode).toBe(503)
  })

  test("does NOT escalate non-error parts, unknown codes, or content-filter errors", () => {
    // Non-error part: text-delta passes through.
    expect(MessageV2.tryEscalateStreamError({ type: "text-delta", text: "hi" })).toBeUndefined()

    // Unknown / non-transient code: ECONNREFUSED, ENOTFOUND.
    expect(
      MessageV2.tryEscalateStreamError({
        type: "error",
        error: { data: { metadata: { code: "ECONNREFUSED" } } },
      }),
    ).toBeUndefined()

    // 4xx (client error) is not escalated.
    expect(MessageV2.tryEscalateStreamError({ type: "error", error: { statusCode: 400 } })).toBeUndefined()

    // 5xx + content_filter must not retry — content-filter check wins.
    expect(
      MessageV2.tryEscalateStreamError({
        type: "error",
        error: { statusCode: 500, message: "response was filtered by Azure content management policy" },
      }),
    ).toBeUndefined()

    // Connection-coded error message that's actually a content filter must also be skipped.
    expect(
      MessageV2.tryEscalateStreamError({
        type: "error",
        error: { code: "ECONNRESET", message: "content_filter triggered" },
      }),
    ).toBeUndefined()

    // Null / non-object input.
    expect(MessageV2.tryEscalateStreamError(null)).toBeUndefined()
    expect(MessageV2.tryEscalateStreamError(undefined)).toBeUndefined()
  })
})
