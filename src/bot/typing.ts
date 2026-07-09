/**
 * Keeps the Telegram "typing…" chat action alive while the agent works.
 * Telegram clears the action after ~5s, so we re-send every 4s.
 */
import type { Api } from "grammy";

export class TypingIndicator {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.ping();
    this.timer = setInterval(() => void this.ping(), 4000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async ping(): Promise<void> {
    try {
      await this.api.sendChatAction(this.chatId, "typing");
    } catch {
      /* non-fatal */
    }
  }
}
