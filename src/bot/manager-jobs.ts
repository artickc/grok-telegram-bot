/**
 * In-memory tracking of work dispatched from General (manager) into project topics.
 * Used for status, context inject, and report-back when a child turn finishes.
 */

export type ManagerJobStatus = "dispatched" | "running" | "done" | "failed" | "cancelled";

export interface ManagerJob {
  id: string;
  originChatId: number;
  originThreadId: number;
  targetThreadId: number;
  targetName: string;
  targetPath: string;
  childSessionId?: string;
  dispatchPrompt: string;
  userAskPreview: string;
  createdAt: number;
  updatedAt: number;
  status: ManagerJobStatus;
  resultSummary?: string;
}

export interface ReportBackMeta {
  jobId: string;
  originChatId: number;
  originThreadId: number;
  userAskPreview: string;
  targetName: string;
  targetPath: string;
  dispatchPrompt: string;
}

const MAX_JOBS = 100;

const jobsById = new Map<string, ManagerJob>();
const jobIdBySession = new Map<string, string>();

let seq = 0;

export function newManagerJobId(): string {
  seq = (seq + 1) % 1_000_000;
  return `mj_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function registerManagerJob(input: {
  originChatId: number;
  originThreadId: number;
  targetThreadId: number;
  targetName: string;
  targetPath: string;
  dispatchPrompt: string;
  userAskPreview: string;
  childSessionId?: string;
}): ManagerJob {
  const now = Date.now();
  const job: ManagerJob = {
    id: newManagerJobId(),
    originChatId: input.originChatId,
    originThreadId: input.originThreadId,
    targetThreadId: input.targetThreadId,
    targetName: input.targetName,
    targetPath: input.targetPath,
    childSessionId: input.childSessionId,
    dispatchPrompt: input.dispatchPrompt,
    userAskPreview: input.userAskPreview,
    createdAt: now,
    updatedAt: now,
    status: "dispatched",
  };
  jobsById.set(job.id, job);
  if (job.childSessionId) jobIdBySession.set(job.childSessionId, job.id);
  trimJobs();
  return job;
}

export function bindJobSession(jobId: string, sessionId: string): void {
  const job = jobsById.get(jobId);
  if (!job) return;
  job.childSessionId = sessionId;
  job.updatedAt = Date.now();
  if (job.status === "dispatched") job.status = "running";
  jobIdBySession.set(sessionId, jobId);
}

export function updateManagerJob(
  jobId: string,
  patch: Partial<Pick<ManagerJob, "status" | "resultSummary" | "childSessionId">>,
): ManagerJob | undefined {
  const job = jobsById.get(jobId);
  if (!job) return undefined;
  if (patch.status !== undefined) job.status = patch.status;
  if (patch.resultSummary !== undefined) job.resultSummary = patch.resultSummary;
  if (patch.childSessionId !== undefined) {
    job.childSessionId = patch.childSessionId;
    jobIdBySession.set(patch.childSessionId, jobId);
  }
  job.updatedAt = Date.now();
  return job;
}

export function getManagerJob(jobId: string): ManagerJob | undefined {
  return jobsById.get(jobId);
}

export function getJobBySession(sessionId: string): ManagerJob | undefined {
  const id = jobIdBySession.get(sessionId);
  return id ? jobsById.get(id) : undefined;
}

/** Active (not terminal) jobs, newest first. */
export function listActiveManagerJobs(limit = 12): ManagerJob[] {
  return [...jobsById.values()]
    .filter((j) => j.status === "dispatched" || j.status === "running")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** Recent jobs including finished, newest first. */
export function listRecentManagerJobs(limit = 12): ManagerJob[] {
  return [...jobsById.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(50, limit)));
}

function trimJobs(): void {
  if (jobsById.size <= MAX_JOBS) return;
  const ordered = [...jobsById.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  const drop = ordered.length - MAX_JOBS;
  for (let i = 0; i < drop; i++) {
    const j = ordered[i]!;
    jobsById.delete(j.id);
    if (j.childSessionId) jobIdBySession.delete(j.childSessionId);
  }
}

/** Test helper: wipe job state. */
export function clearManagerJobsForTests(): void {
  jobsById.clear();
  jobIdBySession.clear();
  seq = 0;
}
