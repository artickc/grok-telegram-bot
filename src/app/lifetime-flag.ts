/**
 * Cross-module intentional-exit flag so beforeExit keep-alive and the polling
 * loop do not fight updater re-exec / fatal exits / SIGINT.
 */
let intentional = false;
let reason = "";

/** Mark that the process is exiting on purpose (do not keep-alive). */
export function markIntentionalShutdown(why: string): void {
  intentional = true;
  reason = why;
}

export function isIntentionalShutdown(): boolean {
  return intentional;
}

export function intentionalShutdownReason(): string {
  return reason;
}
