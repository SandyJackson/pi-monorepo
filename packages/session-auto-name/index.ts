/**
 * Session Auto Name Extension
 *
 * Automatically names unnamed sessions after the first completed agent response.
 * The first user message is treated as the primary signal; the first assistant
 * text response is included only as secondary clarification.
 */

import { complete, type Message } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODEL = {
  provider: "opencode",
  id: "gpt-5-nano",
} as const;

const MAX_TITLE_LENGTH = 80;

const SYSTEM_PROMPT = `You generate concise session names for a coding agent.

Return only the session name, with no quotes, no markdown, no explanation, and no trailing punctuation.
The name should be 5-12 words.
Describe the purpose of the session, not merely the latest action.
The user's message is the strongest signal. Use the assistant response only to clarify intent.`;

type TextContent = {
  type: "text";
  text: string;
};

type MessageEntry = {
  type: "message";
  message: {
    role: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
};

function isMessageEntry(entry: unknown): entry is MessageEntry {
  return (
    typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "message"
  );
}

function textFromContent(content: MessageEntry["message"]["content"]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is TextContent => block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function getNamingContext(entries: unknown[]): { userText: string; assistantText: string } | null {
  let userText = "";
  let assistantText = "";

  for (const entry of entries) {
    if (!isMessageEntry(entry)) continue;

    if (!userText && entry.message.role === "user") {
      userText = textFromContent(entry.message.content);
      continue;
    }

    if (!assistantText && entry.message.role === "assistant") {
      assistantText = textFromContent(entry.message.content);
    }

    if (userText && assistantText) break;
  }

  if (!userText) return null;

  // The trigger is the first completed agent response. An assistant message can
  // be text-free when it only calls tools; in that case the secondary context is
  // intentionally blank.
  const hasAssistantMessage = entries.some(
    (entry) => isMessageEntry(entry) && entry.message.role === "assistant",
  );
  if (!hasAssistantMessage) return null;

  return { userText, assistantText };
}

function sanitizeTitle(rawTitle: string): string {
  const firstLine = rawTitle
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) return "";

  return firstLine
    .replace(/^[-*\d.)\s]+/, "")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/[.:;!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
}

export default function (pi: ExtensionAPI) {
  let notifiedFailure = false;
  let namingInProgress = false;

  function notifyFailureOnce(message: string, ctx: ExtensionContext) {
    if (notifiedFailure) return;
    notifiedFailure = true;
    ctx.ui.notify(message, "warning");
  }

  async function maybeNameSession(ctx: ExtensionContext) {
    if (namingInProgress) return;
    if (pi.getSessionName()) return;

    const namingContext = getNamingContext(ctx.sessionManager.getBranch());
    if (!namingContext) return;

    const model = ctx.modelRegistry.find(MODEL.provider, MODEL.id);
    if (!model) {
      notifyFailureOnce(`session-auto-name: model not found: ${MODEL.provider}/${MODEL.id}`, ctx);
      return;
    }

    namingInProgress = true;
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        notifyFailureOnce(
          `session-auto-name: auth failed for ${MODEL.provider}/${MODEL.id}: ${auth.error}`,
          ctx,
        );
        return;
      }
      if (!auth.apiKey) {
        notifyFailureOnce(`session-auto-name: no API key for ${MODEL.provider}/${MODEL.id}`, ctx);
        return;
      }

      const userMessage: Message = {
        role: "user",
        content: [
          {
            type: "text",
            text: `Generate a session name for this pi coding-agent session.

Primary context - first user message:
${namingContext.userText}

Secondary context - first assistant response:
${namingContext.assistantText}`,
          },
        ],
        timestamp: Date.now(),
      };

      const response = await complete(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [userMessage],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          maxTokens: 64,
          reasoningEffort: "minimal",
          signal: ctx.signal,
        },
      );

      const title = sanitizeTitle(
        response.content
          .filter(
            (block): block is TextContent =>
              block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("\n"),
      );

      if (!title) return;
      if (pi.getSessionName()) return;

      pi.setSessionName(title);
      ctx.ui.notify(`Session named: ${title}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifyFailureOnce(`session-auto-name: failed to generate name: ${message}`, ctx);
    } finally {
      namingInProgress = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await maybeNameSession(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await maybeNameSession(ctx);
  });
}
