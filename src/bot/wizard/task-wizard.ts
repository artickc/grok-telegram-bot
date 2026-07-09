/**
 * Task wizard — a small per-chat state machine that guides task creation and
 * editing through text and inline steps. Decoupled from Telegram: it returns
 * WizardPrompt descriptors that the handler renders.
 */
import { describeSchedule } from "../../tasks/schedule.js";
import { parseScheduleDetail } from "../../tasks/schedule.js";
import type { TaskStore } from "../../tasks/store.js";
import type { Schedule, ScheduleType } from "../../tasks/types.js";

export type WizStep = "name" | "prompt" | "project" | "scheduleType" | "detail" | "confirm";
export type WizKind = "text" | "project" | "scheduleType" | "confirm" | "done" | "aborted";

export interface WizardPrompt {
  kind: WizKind;
  text: string;
  error?: boolean;
}

interface Draft {
  name?: string;
  prompt?: string;
  projectPath?: string;
  projectName?: string;
  type?: ScheduleType;
  schedule?: Schedule;
}

interface WizardState {
  mode: "create" | "edit";
  taskId?: string;
  steps: WizStep[];
  index: number;
  draft: Draft;
}

const CREATE_STEPS: WizStep[] = ["name", "prompt", "project", "scheduleType", "detail", "confirm"];

export class TaskWizard {
  private readonly states = new Map<number, WizardState>();

  constructor(private readonly store: TaskStore) {}

  isActive(chatId: number): boolean {
    return this.states.has(chatId);
  }

  abort(chatId: number): void {
    this.states.delete(chatId);
  }

  startCreate(chatId: number): WizardPrompt {
    this.states.set(chatId, { mode: "create", steps: CREATE_STEPS, index: 0, draft: {} });
    return this.promptFor(chatId)!;
  }

  /** Start an edit flow for a single aspect of an existing task. */
  startEdit(chatId: number, taskId: string, field: "name" | "prompt" | "project" | "schedule"): WizardPrompt | undefined {
    const task = this.store.get(taskId);
    if (!task) return undefined;
    const steps: Record<string, WizStep[]> = {
      name: ["name"],
      prompt: ["prompt"],
      project: ["project"],
      schedule: ["scheduleType", "detail"],
    };
    this.states.set(chatId, {
      mode: "edit",
      taskId,
      steps: steps[field]!,
      index: 0,
      draft: {
        name: task.name,
        prompt: task.prompt,
        projectPath: task.projectPath,
        projectName: task.projectName,
        type: task.schedule.type,
        schedule: task.schedule,
      },
    });
    return this.promptFor(chatId);
  }

  currentKind(chatId: number): WizKind | undefined {
    const s = this.states.get(chatId);
    if (!s) return undefined;
    return kindOf(s.steps[s.index]!);
  }

  handleText(chatId: number, text: string): WizardPrompt | undefined {
    const s = this.states.get(chatId);
    if (!s) return undefined;
    const step = s.steps[s.index]!;
    if (step === "name") s.draft.name = text.trim();
    else if (step === "prompt") s.draft.prompt = text.trim();
    else if (step === "detail") {
      const { schedule, error } = parseScheduleDetail(s.draft.type!, text);
      if (error) return { kind: "text", text: `\u26A0\uFE0F ${error}`, error: true };
      s.draft.schedule = schedule;
    } else {
      return { kind: kindOf(step), text: "Please use the buttons above to continue.", error: true };
    }
    return this.advance(chatId);
  }

  setProject(chatId: number, path: string, name: string): WizardPrompt | undefined {
    const s = this.states.get(chatId);
    if (!s || s.steps[s.index] !== "project") return undefined;
    s.draft.projectPath = path;
    s.draft.projectName = name;
    return this.advance(chatId);
  }

  setScheduleType(chatId: number, type: ScheduleType): WizardPrompt | undefined {
    const s = this.states.get(chatId);
    if (!s || s.steps[s.index] !== "scheduleType") return undefined;
    s.draft.type = type;
    s.draft.schedule = { type };
    return this.advance(chatId);
  }

  confirm(chatId: number): WizardPrompt | undefined {
    const s = this.states.get(chatId);
    if (!s || s.steps[s.index] !== "confirm") return undefined;
    return this.finalize(chatId);
  }

  private advance(chatId: number): WizardPrompt {
    const s = this.states.get(chatId)!;
    s.index += 1;
    if (s.index >= s.steps.length) return this.finalize(chatId);
    return this.promptFor(chatId)!;
  }

  private finalize(chatId: number): WizardPrompt {
    const s = this.states.get(chatId)!;
    const d = s.draft;
    this.states.delete(chatId);
    if (s.mode === "create") {
      const task = this.store.create({
        chatId,
        name: d.name ?? "Task",
        prompt: d.prompt ?? "",
        projectPath: d.projectPath ?? "",
        projectName: d.projectName,
        schedule: d.schedule!,
      });
      return { kind: "done", text: `\u2705 Task "${task.name}" created \u2014 ${describeSchedule(task.schedule)}.` };
    }
    this.store.update(s.taskId!, {
      name: d.name,
      prompt: d.prompt,
      projectPath: d.projectPath,
      projectName: d.projectName,
      schedule: d.schedule,
    });
    return { kind: "done", text: "\u2705 Task updated." };
  }

  private promptFor(chatId: number): WizardPrompt | undefined {
    const s = this.states.get(chatId);
    if (!s) return undefined;
    const step = s.steps[s.index]!;
    switch (step) {
      case "name":
        return { kind: "text", text: "\u{1F4DD} Send a name for the task." };
      case "prompt":
        return { kind: "text", text: "\u{1F4AC} Send the prompt Grok should run when it fires." };
      case "project":
        return { kind: "project", text: "\u{1F4C1} Pick the project to run it in:" };
      case "scheduleType":
        return { kind: "scheduleType", text: "\u{1F5D3} How often should it run?" };
      case "detail":
        return { kind: "text", text: detailQuestion(s.draft.type!) };
      case "confirm":
        return { kind: "confirm", text: this.summary(s.draft) };
    }
  }

  private summary(d: Draft): string {
    const p = d.prompt && d.prompt.length > 120 ? d.prompt.slice(0, 120) + "…" : d.prompt;
    return [
      "\u{1F4CB} Review the task:",
      `\u2022 Name: ${d.name}`,
      `\u2022 Project: ${d.projectName ?? d.projectPath}`,
      `\u2022 Schedule: ${d.schedule ? describeSchedule(d.schedule) : "?"}`,
      `\u2022 Prompt: ${p}`,
      "",
      "Save this task?",
    ].join("\n");
  }
}

function kindOf(step: WizStep): WizKind {
  if (step === "project") return "project";
  if (step === "scheduleType") return "scheduleType";
  if (step === "confirm") return "confirm";
  return "text";
}

function detailQuestion(type: ScheduleType): string {
  switch (type) {
    case "once":
      return "\u{1F5D3} Enter date & time:  YYYY-MM-DD HH:MM";
    case "daily":
      return "\u{1F550} Enter time (24h):  HH:MM";
    case "weekly":
      return "\u{1F5D3} Enter day & time:  e.g.  Mon 09:00";
    case "monthly":
      return "\u{1F5D3} Enter day-of-month & time:  e.g.  15 09:00";
    case "interval":
      return "\u23F1 Run every how many minutes?  e.g.  90";
  }
}
