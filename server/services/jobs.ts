import { bus } from '../lib/events.ts';
import { errMsg, log } from '../lib/log.ts';

/**
 * 오래 걸리는 작업 (DB 초기화, 런타임 설치, 복원 등) 의 진행 로그를 UI 로 흘려보낸다.
 * 채널: 'jobs' (목록 변화), 'job:<id>' (로그 줄)
 */
export interface Job {
  id: number;
  kind: string;
  target: string;
  title: string;
  status: 'running' | 'done' | 'failed';
  lines: string[];
  error: string | null;
  /** 끝난 뒤 UI 에 줄 값 (예: { download: '/api/backups/3/download' }) */
  result: Record<string, unknown> | null;
  startedAt: number;
  finishedAt: number | null;
}

const jobs = new Map<number, Job>();
let seq = 0;

export function startJob(kind: string, target: string, title: string, fn: (log: (line: string) => void) => Promise<void | Record<string, unknown>>): Job {
  const job: Job = {
    id: ++seq,
    kind,
    target,
    title,
    status: 'running',
    lines: [],
    error: null,
    result: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  const push = (line: string) => {
    job.lines.push(line);
    if (job.lines.length > 2000) job.lines.splice(0, job.lines.length - 2000);
    bus.publish(`job:${job.id}`, { line });
  };
  bus.publish('jobs', summary(job));
  fn(push)
    .then((r) => {
      job.result = r ?? null;
      job.status = 'done';
    })
    .catch((e) => {
      job.status = 'failed';
      job.error = errMsg(e);
      push(`오류: ${job.error}`);
      log.warn(`job ${kind}/${target} failed: ${job.error}`);
    })
    .finally(() => {
      job.finishedAt = Date.now();
      bus.publish('jobs', summary(job));
      bus.publish(`job:${job.id}`, { done: true, status: job.status, error: job.error, result: job.result });
      // 완료된 작업은 1시간 뒤 정리
      setTimeout(() => jobs.delete(job.id), 3600_000).unref();
    });
  return job;
}

export function summary(j: Job) {
  const { lines: _l, ...rest } = j;
  return rest;
}

export function getJob(id: number) {
  return jobs.get(id) ?? null;
}

export function listJobs() {
  return [...jobs.values()].map(summary).sort((a, b) => b.id - a.id);
}

export function runningJobFor(kind: string, target: string) {
  return [...jobs.values()].find((j) => j.kind === kind && j.target === target && j.status === 'running') ?? null;
}
