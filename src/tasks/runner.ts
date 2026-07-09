/**
 * Executes a scheduled task: opens a fresh session in the task's project,
 * sends the prompt, collects the response, and delivers it to the chat.
 * Runs independently of the user's interactive session.
 */
import type { Api } from "grammy";
import { basename } from "node:path";
import type { GrokClient } from "../grok/client.js";
import type { SessionUpdate } from "../grok/types.js";
import { createLogger } from "../logger.js";
import { sendMarkdownDoc } from "../bot/telegram-io.js";
import type { Task } from "./types.js";

const log = createLogger("task-runner");

export class TaskRunner {
  constructor(
    private readonly api: Api,
    private readonly acp: GrokClient,
  ) {}

  /** Run a task; resolves true on success, false on error. */
  async run(task: Task): Promise<boolean> {
    log.info(`running task "${task.name}" in ${task.projectPath}`);
    let sessionId = "";
    let text = "";
    let tools = 0;
    const seen = new Set<string>();

    const listener = (sid: string, u: SessionUpdate): void => {
      if (sid !== sessionId) return;
      if (u.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") {
        text += u.content.text;
      } else if (u.sessionUpdate === "tool_call") {
        const id = u.toolCallId || u.title || String(tools);
        if (!seen.has(id)) {
          seen.add(id);
          tools++;
        }
      }
    };

    try {
      sessionId = await this.acp.newSession(task.projectPath);
      if (task.agent) {
        try {
          await this.acp.setMode(sessionId, task.agent);
        } catch {
          /* best-effort */
        }
      }
      this.acp.on("session-update", listener);
      await this.acp.prompt(sessionId, [{ type: "text", text: task.prompt }]);
      this.acp.off("session-update", listener);
      await this.deliver(task, text, tools);
      return true;
    } catch (err) {
      this.acp.off("session-update", listener);
      await this.deliverError(task, (err as Error).message);
      log.error(`task "${task.name}" failed:`, (err as Error).message);
      return false;
    }
  }

  private async deliver(task: Task, text: string, tools: number): Promise<void> {
    const project = task.projectName || basename(task.projectPath);
    const body = text.trim() || "_(no text output)_";
    const footer = tools > 0 ? `\n\n\u{1F527} ${tools} tool call(s)` : "";
    const header = `\u23F0 **Task: ${task.name}** \u00B7 ${project}`;
    await sendMarkdownDoc(this.api, task.chatId, `${header}\n\n${body}${footer}`, { loud: true });
  }

  private async deliverError(task: Task, message: string): Promise<void> {
    try {
      await this.api.sendMessage(task.chatId, `\u274C Task "${task.name}" failed: ${message}`, {
        disable_notification: false,
      });
    } catch {
      /* non-fatal */
    }
  }
}
