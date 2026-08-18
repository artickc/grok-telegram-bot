/**
 * Cross-platform service (daemon) abstraction.
 */

export interface LaunchSpec {
  /** Internal service id, e.g. "grok-telegram-bot" or "grok-telegram-bot-work". */
  id: string;
  /** Human-readable name. */
  displayName: string;
  /** Windows Scheduled Task / Startup launcher name. */
  windowsTaskName: string;
  /** launchd label, e.g. "com.grok.telegrambot" or "com.grok.telegrambot.work". */
  macosLabel: string;
  /** Present for named instances (`--name work`). */
  slug?: string;
  /** Absolute path to the node binary that should run the bot. */
  nodePath: string;
  /** Arguments after the node binary (tsx loader + entry file). */
  args: string[];
  /** Working directory (the installed bot folder). */
  cwd: string;
  /** Extra environment variables for the service process. */
  env?: Record<string, string>;
  /** Absolute log file path. */
  logFile: string;
  /** Log directory. */
  logsDir: string;
}

export interface ServiceResult {
  ok: boolean;
  message: string;
}

export interface ServiceController {
  readonly platform: string;
  install(spec: LaunchSpec): Promise<ServiceResult>;
  uninstall(spec: LaunchSpec): Promise<ServiceResult>;
  start(spec: LaunchSpec): Promise<ServiceResult>;
  stop(spec: LaunchSpec): Promise<ServiceResult>;
  status(spec: LaunchSpec): Promise<ServiceResult>;
}
