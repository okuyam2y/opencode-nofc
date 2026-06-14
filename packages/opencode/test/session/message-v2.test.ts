import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { APICallError, modelMessageSchema } from "ai"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"

import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Question } from "../../src/question"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")
const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
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

function userInfo(id: string): SessionV1.User {
  return {
    id: MessageID.make(id.startsWith("msg") ? id : `msg_${id}`),
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelV2.ID.make("test") },
    tools: {},
    mode: "",
  } as unknown as SessionV1.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: SessionV1.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): SessionV1.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id: MessageID.make(id.startsWith("msg") ? id : `msg_${id}`),
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID: parentID ? MessageID.make(parentID.startsWith("msg") ? parentID : `msg_${parentID}`) : undefined,
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
  } as unknown as SessionV1.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

describe("session.message-v2.toModelMessage", () => {
  test("filters out messages with no parts", async () => {
    const input: SessionV1.WithParts[] = [
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
        ] as SessionV1.Part[],
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

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters out user messages with only empty text parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters empty user text parts while keeping non-empty parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "hello",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("includes synthetic text parts", async () => {
    const messageID = "m-user"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as SessionV1.Part[],
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
        ] as SessionV1.Part[],
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

    const input: SessionV1.WithParts[] = [
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
        ] as SessionV1.Part[],
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

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
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
        ] as SessionV1.Part[],
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
      id: ModelV2.ID.make("anthropic/claude-opus-4-7"),
      providerID: ProviderV2.ID.make("anthropic"),
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
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-anthropic"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
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
        ] as SessionV1.Part[],
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

  test("moves bedrock pdf tool-result media into a separate user message", async () => {
    const bedrockModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("amazon-bedrock/anthropic.claude-sonnet-4-6"),
      providerID: ProviderV2.ID.make("amazon-bedrock"),
      api: {
        id: "anthropic.claude-sonnet-4-6",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
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
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64")
    const userID = "m-user-bedrock-pdf"
    const assistantID = "m-assistant-bedrock-pdf"
    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-bedrock-pdf"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-bedrock-pdf"),
            type: "tool",
            callID: "call-bedrock-pdf-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/example.pdf" },
              output: "PDF read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-bedrock-pdf-1"),
                  type: "file",
                  mime: "application/pdf",
                  filename: "example.pdf",
                  url: `data:application/pdf;base64,${pdf}`,
                },
              ],
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, bedrockModel)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            input: { filePath: "/tmp/example.pdf" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            output: { type: "text", value: "PDF read successfully" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Attached media from tool result:" },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "example.pdf",
            data: `data:application/pdf;base64,${pdf}`,
          },
        ],
      },
    ])
  })

  test("omits provider metadata when assistant model differs", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
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
            type: "reasoning",
            text: "thinking",
            metadata: { openai: { reasoning: "meta" } },
            time: { start: 0 },
          },
          {
            ...basePart(assistantID, "a3"),
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
        ] as SessionV1.Part[],
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
          { type: "text", text: "thinking" },
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

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
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
        ] as SessionV1.Part[],
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

  test("truncates tool output when requested", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
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
              output: "abcdefghij",
              title: "Shell",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model, { toolOutputMaxChars: 4 })).toStrictEqual([
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
            output: {
              type: "text",
              value: "abcd\n[Tool output truncated for compaction: omitted 6 chars]",
            },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
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
        ] as SessionV1.Part[],
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
      "<shell_metadata>",
      "User aborted the command",
      "</shell_metadata>",
    ].join("\n")

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
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
        ] as SessionV1.Part[],
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

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new SessionV1.APIError({ message: "boom", isRetryable: true }).toObject() as SessionV1.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", async () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new SessionV1.AbortedError({
      message: "aborted",
    }).toObject() as SessionV1.Assistant["error"]

    const input: SessionV1.WithParts[] = [
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
        ] as SessionV1.Part[],
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
        ] as SessionV1.Part[],
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

  test("preserves OpenRouter reasoning details through provider transform", async () => {
    const assistantID = "m-assistant"
    const openrouterModel: Provider.Model = {
      ...model,
      id: ModelV2.ID.make("deepseek/deepseek-v4-pro"),
      providerID: ProviderV2.ID.make("openrouter"),
      api: {
        id: "deepseek/deepseek-v4-pro",
        url: "https://openrouter.ai/api/v1",
        npm: "@openrouter/ai-sdk-provider",
      },
      capabilities: {
        ...model.capabilities,
        reasoning: true,
        interleaved: { field: "reasoning_details" },
      },
    }
    const reasoningDetails = [
      {
        type: "reasoning.text",
        text: "thinking",
        format: "unknown",
        index: 0,
      },
    ]
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent", undefined, {
          providerID: openrouterModel.providerID,
          modelID: openrouterModel.id,
        }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
            metadata: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "text",
            text: "answer",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(
      ProviderTransform.message(await MessageV2.toModelMessages(input, openrouterModel), openrouterModel, {}),
    ).toStrictEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          { type: "text", text: "answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", async () => {
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
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
        ] as SessionV1.Part[],
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

    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as SessionV1.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: SessionV1.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as SessionV1.Part[],
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
        ] as SessionV1.Part[],
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
    const userID = MessageID.make("msg_u-soft")
    const assistantID = MessageID.make("msg_a-soft")
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
    const userID = MessageID.make("msg_u-ok")
    const assistantID = MessageID.make("msg_a-ok")
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
    const userID = MessageID.make("msg_u-compact")
    const assistantID = MessageID.make("msg_a-compact")
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

  test("substitutes space for empty text between signed reasoning blocks", async () => {
    // Reproduces the bug pattern: [reasoning(sig), text(""), reasoning(sig), text(full)]
    const assistantID = "m-assistant"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "step-start" },
          {
            ...basePart(assistantID, "p2"),
            type: "reasoning",
            text: "thinking-one",
            metadata: { anthropic: { signature: "sig1" } },
          },
          { ...basePart(assistantID, "p3"), type: "text", text: "" },
          { ...basePart(assistantID, "p4"), type: "step-start" },
          {
            ...basePart(assistantID, "p5"),
            type: "reasoning",
            text: "thinking-two",
            metadata: { anthropic: { signature: "sig2" } },
          },
          { ...basePart(assistantID, "p6"), type: "text", text: "the answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    // step-start splits into two assistant messages; SDK's groupIntoBlocks merges them later
    expect(result).toHaveLength(2)
    expect((result[0].content as any[]).find((p) => p.type === "text").text).toBe(" ")
    expect((result[1].content as any[]).find((p) => p.type === "text").text).toBe("the answer")
  })

  test("leaves empty text alone when reasoning signature is under 'bedrock' namespace", async () => {
    // Bedrock signed reasoning is preserved as reasoning metadata, but unlike the
    // direct Anthropic path we do not preserve empty text separators for Bedrock.
    const assistantID = "m-assistant-bedrock"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "reasoning",
            text: "thinking-bedrock",
            metadata: { bedrock: { signature: "bedrock-sig" } },
          },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "answer"])
  })

  test("leaves empty text alone when reasoning has no Anthropic signature", async () => {
    // Non-Anthropic providers' reasoning doesn't position-validate, so empty text
    // should be filtered normally rather than substituted.
    const assistantID = "m-assistant-unsigned"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "reasoning", text: "thinking" },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "answer"])
  })

  test("leaves empty text alone in assistant messages without reasoning", async () => {
    const assistantID = "m-assistant-no-reasoning"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "text", text: "" },
          { ...basePart(assistantID, "p2"), type: "text", text: "hello" },
        ] as SessionV1.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "hello"])
  })
})

describe("session.message-v2.fromError", () => {
  test("stamps nonRetryable on a 5xx content-filter so retryable()'s 5xx hatch cannot retry it", () => {
    // A content filter is a verdict on the prompt. Without the hard veto, the
    // 5xx force-retry escape hatch in retryable() ignores isRetryable:false and
    // retries it forever (C-011).
    const result = MessageV2.fromError(
      { statusCode: 503, message: "response was filtered by Azure content management policy" },
      { providerID },
    )
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    const api = result as Extract<typeof result, { name: "APIError" }>
    expect(api.data.statusCode).toBe(503)
    expect(api.data.isRetryable).toBe(false)
    expect(api.data.nonRetryable).toBe(true)
    // The whole point: retryable() must refuse it despite status >= 500.
    expect(SessionRetry.retryable(result as any, providerID)).toBeUndefined()
  })

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

  test("serializes OpenAI response server_error stream chunks as retryable APIError", () => {
    const body = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "server_error",
        code: "server_error",
        message:
          "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_77eccd008d984bf6bf82d1b2c2b68715 in your message.",
        param: null,
      },
    }
    const result = MessageV2.fromError({ message: JSON.stringify(body) }, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.error.message,
        isRetryable: true,
        responseBody: JSON.stringify(body),
      },
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
      expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(true)
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
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(true)
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
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(false)
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
  })

  const nginx400 = "<html>\r\n<head><title>400 Bad Request</title></head>\r\n<body>\r\n<center><h1>400 Bad Request</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n"

  test("explains a generic nginx 400 with a large request body as a proxy rejection (api_error, no auto-compact)", () => {
    // A proxy in front of the gateway can reject a large request with an unstructured
    // HTML 400 while far below the model's token window. Stay api_error (do NOT compact —
    // mid-task compaction discards verbatim tool output and causes confabulated findings,
    // docs/devlog 2026-06-10 §1) but make the message actionable.
    const error = new APICallError({
      message: "Bad Request",
      url: "https://example.com",
      requestBodyValues: { messages: [{ role: "user", content: "x".repeat(200 * 1024) }] },
      statusCode: 400,
      responseHeaders: { "content-type": "text/html", server: "cloudflare" },
      responseBody: nginx400,
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(false)
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    expect(JSON.stringify(result)).toContain("rejected by a gateway/proxy")
    expect(JSON.stringify(result)).toContain("smaller scope")
  })

  test("keeps the terse message for a generic nginx 400 with a small request body", () => {
    // Small malformed requests are genuine bad requests, not proxy size/content rejections.
    const error = new APICallError({
      message: "Bad Request",
      url: "https://example.com",
      requestBodyValues: { messages: [{ role: "user", content: "hello" }] },
      statusCode: 400,
      responseHeaders: { "content-type": "text/html" },
      responseBody: nginx400,
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(false)
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain("rejected by a gateway/proxy")
  })

  test("does not add the proxy hint to a large 400 that carries a structured JSON error", () => {
    // A structured model-service error (JSON body, not HTML/empty) is a real bad request
    // even when the request is large — leave the message as-is.
    const error = new APICallError({
      message: "Bad Request",
      url: "https://example.com",
      requestBodyValues: { messages: [{ role: "user", content: "x".repeat(200 * 1024) }] },
      statusCode: 400,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({ error: { message: "unsupported parameter", type: "invalid_request_error" } }),
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(false)
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain("rejected by a gateway/proxy")
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

    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    expect((result as SessionV1.APIError).data.isRetryable).toBe(true)
    expect((result as SessionV1.APIError).data.message).toInclude("decompression")
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
    const toolPartID = PartID.make("prt_a1")

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
            messageID: MessageID.make(assistantID.startsWith("msg") ? assistantID : `msg_${assistantID}`),
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
    const toolPartID = PartID.make("prt_a1")

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
            messageID: MessageID.make(assistantID.startsWith("msg") ? assistantID : `msg_${assistantID}`),
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
    const toolPartID = PartID.make("prt_a1")

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
            messageID: MessageID.make(assistantID.startsWith("msg") ? assistantID : `msg_${assistantID}`),
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
    const pending = new Map<string, string>([[PartID.make("prt_other"), "[RESET]"]])
    const result = await MessageV2.toModelMessages(input, model, { pendingDirectives: pending })
    const toolMsg = result.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    expect((toolMsg as any).content[0].output.value).toBe("ripgrep failed with exit 2")
  })

  test("providerMeta drops internal flags from callProviderMetadata on hermes notFound path", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const toolPartID = PartID.make("prt_a1")

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
            messageID: MessageID.make(assistantID.startsWith("msg") ? assistantID : `msg_${assistantID}`),
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
              // A passthrough field must survive — but it must be a settings
              // OBJECT, not a scalar.  AI SDK providerOptions is typed
              // Record<string, Record<string, JSONValue>>; a bare scalar value
              // fails ModelMessage[] validation and kills the stream (the exact
              // session-death this file regresses), so providerMeta() drops
              // non-object top-level entries as defense-in-depth.
              customPassthrough: { keep: "me" },
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
    // object-valued passthrough field preserved.  Without asserting on
    // providerOptions the test would still pass if providerMeta() were a no-op,
    // so this is the load-bearing assertion.
    expect(resultItem.providerOptions).toEqual({ customPassthrough: { keep: "me" } })
  })

  test("providerMeta forwards passthrough metadata on hermes notFound rewrite", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const toolPartID = PartID.make("prt_a1")

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
            messageID: MessageID.make(assistantID.startsWith("msg") ? assistantID : `msg_${assistantID}`),
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
    const toolPartID = PartID.make("prt_a1")

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
            messageID: MessageID.make(assistantID.startsWith("msg") ? assistantID : `msg_${assistantID}`),
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
    const toolPartID = PartID.make("prt_a1")

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
            messageID: MessageID.make(assistantID.startsWith("msg") ? assistantID : `msg_${assistantID}`),
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

describe("session.message-v2.latest", () => {
  const TAIL_USER = MessageID.make("msg_001")
  const OVERFLOW_ASSISTANT = MessageID.make("msg_002")
  const COMPACTION_USER = MessageID.make("msg_003")
  const SUMMARY_ASSISTANT = MessageID.make("msg_004")
  const CONTINUE_USER = MessageID.make("msg_005")
  const NEW_COMPACTION_USER = MessageID.make("msg_006")

  const tailUser: SessionV1.WithParts = {
    info: userInfo(TAIL_USER),
    parts: [{ ...basePart(TAIL_USER, "p1"), type: "text", text: "original prompt" }] as SessionV1.Part[],
  }

  const overflowAssistant: SessionV1.WithParts = {
    info: {
      ...assistantInfo(OVERFLOW_ASSISTANT, TAIL_USER),
      finish: "tool-calls",
      tokens: { input: 280_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 }, total: 280_200 },
    } as SessionV1.Assistant,
    parts: [],
  }

  const compactionUser: SessionV1.WithParts = {
    info: userInfo(COMPACTION_USER),
    parts: [
      {
        ...basePart(COMPACTION_USER, "p1"),
        type: "compaction",
        auto: true,
        tail_start_id: TAIL_USER,
      },
    ] as SessionV1.Part[],
  }

  const summaryAssistant: SessionV1.WithParts = {
    info: {
      ...assistantInfo(SUMMARY_ASSISTANT, COMPACTION_USER),
      summary: true,
      finish: "stop",
      tokens: { input: 150_000, output: 1_500, reasoning: 0, cache: { read: 0, write: 0 }, total: 151_500 },
    } as SessionV1.Assistant,
    parts: [],
  }

  const continueUser: SessionV1.WithParts = {
    info: userInfo(CONTINUE_USER),
    parts: [
      {
        ...basePart(CONTINUE_USER, "p1"),
        type: "text",
        text: "Continue if you have next steps...",
        synthetic: true,
        metadata: { compaction_continue: true },
      },
    ] as SessionV1.Part[],
  }

  // Regression for double auto-compaction. The reorder in filterCompacted
  // (#27145) returns [compaction-user, summary, ...tail..., continue-user],
  // so picking lastFinished by array position landed on the pre-compaction
  // overflow assistant and bypassed the `summary !== true` overflow guard
  // in SessionPrompt.runLoop, firing a second compaction.create immediately.
  test("finished is the chronologically-latest finished assistant, not the array-latest", () => {
    const filtered = MessageV2.filterCompacted([
      continueUser,
      summaryAssistant,
      compactionUser,
      overflowAssistant,
      tailUser,
    ])

    const state = MessageV2.latest(filtered)

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.finished?.summary).toBe(true)
    expect(state.user?.id).toBe(CONTINUE_USER)
    expect(state.tasks).toEqual([])
  })

  test("a fresh compaction-user newer than the latest summary surfaces in tasks", () => {
    const newCompactionUser: SessionV1.WithParts = {
      info: userInfo(NEW_COMPACTION_USER),
      parts: [
        {
          ...basePart(NEW_COMPACTION_USER, "p1"),
          type: "compaction",
          auto: true,
        },
      ] as SessionV1.Part[],
    }

    const state = MessageV2.latest([
      tailUser,
      overflowAssistant,
      compactionUser,
      summaryAssistant,
      continueUser,
      newCompactionUser,
    ])

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.user?.id).toBe(NEW_COMPACTION_USER)
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ type: "compaction", auto: true })
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

  test("escalates bare-string connection drops from Bun's socket layer (observed 2026-06-11 run=193767de)", () => {
    // The error part carried a plain string, no code property — the shape-based
    // extraction missed it and the session died as non-retryable UnknownError.
    const part = {
      type: "error" as const,
      error: "recvAddress(..) failed with error(-104): Connection reset by peer",
    }
    const escalated = MessageV2.tryEscalateStreamError(part)
    expect(escalated).toBeInstanceOf(MessageV2.StreamRetryableError)
    expect(escalated?.statusCode).toBeUndefined()
    expect(escalated?.message).toContain("Connection reset by peer")
  })

  test("escalates message-only error objects without a code property", () => {
    const part = {
      type: "error" as const,
      error: { message: "The socket connection was closed unexpectedly. For more information, pass `verbose: true`" },
    }
    expect(MessageV2.tryEscalateStreamError(part)).toBeInstanceOf(MessageV2.StreamRetryableError)
  })

  test("does NOT escalate unrelated string errors", () => {
    expect(
      MessageV2.tryEscalateStreamError({ type: "error", error: "model produced malformed output" }),
    ).toBeUndefined()
  })

  test("does NOT escalate status-bearing sub-5xx errors whose message merely mentions a connection reset", () => {
    // A 4xx with connection-reset text in the body is a server verdict, not a
    // transport drop — message-based detection must not strip its status.
    expect(
      MessageV2.tryEscalateStreamError({
        type: "error",
        error: { statusCode: 400, message: "upstream proxy: connection reset while reading client body" },
      }),
    ).toBeUndefined()
  })
})

describe("MessageV2.isConnectionErrorMessage", () => {
  test("matches observed connection-drop messages in string and object shapes", () => {
    expect(MessageV2.isConnectionErrorMessage("recvAddress(..) failed with error(-104): Connection reset by peer")).toBe(true)
    expect(MessageV2.isConnectionErrorMessage({ message: "The socket connection was closed unexpectedly" })).toBe(true)
    expect(MessageV2.isConnectionErrorMessage({ data: { message: "Connection reset by server" } })).toBe(true)
  })

  test("rejects non-connection messages and non-string shapes", () => {
    expect(MessageV2.isConnectionErrorMessage("SSE read timed out")).toBe(false)
    expect(MessageV2.isConnectionErrorMessage({ message: "Bad Request" })).toBe(false)
    expect(MessageV2.isConnectionErrorMessage(null)).toBe(false)
    expect(MessageV2.isConnectionErrorMessage(undefined)).toBe(false)
    expect(MessageV2.isConnectionErrorMessage(42)).toBe(false)
  })
})

// C-068: pin implemented branches that had no test — numeric `.code` and
// `.response.statusCode` status candidates, the JSON.stringify catch-all in
// isContentFilter, and ECONNABORTED (the only CONNECTION_ERROR_CODES member
// without a case).
describe("session.message-v2 error-shape branch pins (C-068)", () => {
  test("extractStatusCode reads numeric .code and .response.statusCode", () => {
    expect(MessageV2.extractStatusCode({ code: 503 })).toBe(503)
    expect(MessageV2.extractStatusCode({ response: { statusCode: 502 } })).toBe(502)
    // string codes (ECONNRESET et al.) must NOT be returned as status codes
    expect(MessageV2.extractStatusCode({ code: "ECONNRESET" })).toBeUndefined()
  })

  test("isContentFilter matches deeply nested shapes via the stringify catch-all", () => {
    expect(MessageV2.isContentFilter({ error: { details: { reason: "response was filtered" } } })).toBe(true)
    expect(MessageV2.isContentFilter({ error: { details: { reason: "quota exceeded" } } })).toBe(false)
  })

  test("extractConnectionErrorCode recognizes ECONNABORTED", () => {
    expect(MessageV2.extractConnectionErrorCode({ code: "ECONNABORTED" })).toBe("ECONNABORTED")
    expect(MessageV2.extractConnectionErrorCode({ cause: { code: "ECONNABORTED" } })).toBe("ECONNABORTED")
  })
})

// C-044: a plain-text rate-limit error maps to UnknownError, whose schema has
// no veto field — retryable()'s rate-limit-text fallback would approve a
// post-tool retry and rollbackAttempt would convert it into a hard defect
// masking the original error. fromError(forceNonRetryable) re-wraps it as a
// vetoed APIError instead.
describe("MessageV2.fromError forceNonRetryable on plain-text rate limits (C-044)", () => {
  const rateLimited = new Error("upstream says: rate limit exceeded, slow down")

  test("re-wraps UnknownError as a vetoed APIError and the retry veto wins", () => {
    const result = MessageV2.fromError(rateLimited, { providerID, forceNonRetryable: true })
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    expect((result.data as any).nonRetryable).toBe(true)
    expect((result.data as any).message).toContain("rate limit exceeded")
    expect(SessionRetry.retryable(result, "test")).toBeUndefined()
  })

  test("pre-tool (no veto) the same error stays Unknown and remains retryable", () => {
    const result = MessageV2.fromError(rateLimited, { providerID })
    expect(result.name).toBe("UnknownError")
    expect(SessionRetry.retryable(result, "test")).toMatchObject({
      message: expect.stringContaining("rate limit"),
    })
  })
})

describe("MessageV2.toModelMessages internal-flag metadata does not break ModelMessage schema", () => {
  // Regression for the hermes "incomplete tool call → Invalid prompt: messages
  // do not match the ModelMessage[] schema" session-death. The drop-recovery
  // synthetic tool part (processor.ts) carries metadata { dropRecovery: true }.
  // When the rebuild runs with the SAME model (differentModel === false), that
  // flat boolean used to flow through callProviderMetadata into AI SDK
  // providerOptions, whose schema requires every value to be a settings object.
  // The boolean failed validation and killed the whole stream. providerMeta()
  // must strip it (and any other flat top-level flag).
  test("drop-recovery tool part validates against AI SDK modelMessageSchema", async () => {
    const messageID = "m-asst"
    const input: SessionV1.WithParts[] = [
      {
        // assistantInfo with no meta → providerID/modelID match `model`, so
        // differentModel === false (the production rebuild path).
        info: assistantInfo(messageID, "m-parent"),
        parts: [
          { ...basePart(messageID, "p0"), type: "step-start" },
          {
            ...basePart(messageID, "p1"),
            type: "tool",
            tool: "grep",
            // Non-standard callID (no "call_" prefix) like the synthetic part
            callID: "Z7pisxEXP060hQDJ",
            state: {
              status: "error",
              input: {},
              error: "Tool call was incomplete (closing tag missing). Tool: grep. Please retry this tool call.",
              time: { start: 0, end: 0 },
            },
            metadata: { dropRecovery: true },
          },
        ] as SessionV1.Part[],
      },
    ]

    const out = await MessageV2.toModelMessages(input, model)
    // 1. The whole prompt must validate against the schema standardizePrompt uses.
    expect(z.array(modelMessageSchema).safeParse(out).success).toBe(true)
    // 2. The internal flag must not survive as providerOptions on the tool-call.
    const assistant = out.find((m) => m.role === "assistant")!
    const toolCall = (assistant.content as any[]).find((c) => c.type === "tool-call")
    expect(toolCall.providerOptions).toBeUndefined()
  })

  test("object-valued provider metadata still passes through", async () => {
    const messageID = "m-asst2"
    const input: SessionV1.WithParts[] = [
      {
        info: assistantInfo(messageID, "m-parent"),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "tool",
            tool: "grep",
            callID: "call_legit",
            state: {
              status: "error",
              input: { pattern: "x" },
              error: "boom",
              time: { start: 0, end: 0 },
            },
            // A real provider settings object must survive the sanitization.
            metadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
          },
        ] as SessionV1.Part[],
      },
    ]

    const out = await MessageV2.toModelMessages(input, model)
    expect(z.array(modelMessageSchema).safeParse(out).success).toBe(true)
    const assistant = out.find((m) => m.role === "assistant")!
    const toolCall = (assistant.content as any[]).find((c) => c.type === "tool-call")
    expect(toolCall.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } })
  })
})
