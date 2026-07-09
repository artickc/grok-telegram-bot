/** Scheduled task model. */

export type ScheduleType = "once" | "daily" | "weekly" | "monthly" | "interval";

export interface Schedule {
  type: ScheduleType;
  /** ISO datetime for one-off tasks. */
  at?: string;
  /** "HH:MM" 24h local time for daily/weekly/monthly. */
  time?: string;
  /** 0=Sunday … 6=Saturday, for weekly. */
  weekday?: number;
  /** 1..31, for monthly. */
  day?: number;
  /** Minutes between runs, for interval. */
  everyMinutes?: number;
}

export interface Task {
  id: string;
  chatId: number;
  name: string;
  prompt: string;
  projectPath: string;
  projectName?: string;
  agent?: string;
  schedule: Schedule;
  enabled: boolean;
  nextRun?: number; // epoch ms
  lastRun?: number;
  lastStatus?: "ok" | "error" | "running";
  createdAt: number;
}
