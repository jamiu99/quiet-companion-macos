// Generation job registry: at most one job per (character, kind); every change is emitted for the renderer
// (push:character-job + AppState.characterJobs). Finished / failed jobs stay listed until the next one starts.
import { EventEmitter } from 'node:events';
import type { CharacterJob, CharacterJobKind } from '@shared/events';

export const JOB_LABEL: Record<CharacterJobKind, string> = { portrait: '形象', idle: '待机视频', art: 'Q 版形象' };
export type JobPatch = Pick<CharacterJob, 'phase'> & Partial<Pick<CharacterJob, 'progress' | 'message' | 'error'>>;
export type JobTask = (report: (patch: JobPatch) => void) => Promise<void>;

export class CharacterJobs extends EventEmitter<{ job: [CharacterJob]; change: [CharacterJob[]] }> {
  private jobs = new Map<string, CharacterJob>();
  private key(id: string, kind: CharacterJobKind) { return `${id}:${kind}`; }

  list(): CharacterJob[] { return [...this.jobs.values()]; }
  get(id: string, kind: CharacterJobKind) { return this.jobs.get(this.key(id, kind)); }
  isRunning(job?: CharacterJob) { return Boolean(job) && job!.phase !== 'done' && job!.phase !== 'failed'; }
  /** True while any job of this character is in flight. */
  busy(id: string) { return this.list().some(j => j.characterId === id && this.isRunning(j)); }

  /** Start `task`; resolves immediately after the job is registered. Errors end up as phase 'failed'. */
  start(characterId: string, kind: CharacterJobKind, task: JobTask): CharacterJob {
    if (this.isRunning(this.get(characterId, kind))) throw new Error(`这个角色的${JOB_LABEL[kind]}正在生成中`);
    const now = Date.now();
    const job: CharacterJob = { characterId, kind, phase: 'submitted', message: '准备中', startedAt: now, updatedAt: now };
    const put = (patch: JobPatch) => { const cur = this.jobs.get(this.key(characterId, kind)); if (!cur || cur.startedAt !== now) return; const next = { ...cur, ...patch, updatedAt: Date.now() }; this.jobs.set(this.key(characterId, kind), next); this.emit('job', next); this.emit('change', this.list()); };
    this.jobs.set(this.key(characterId, kind), job);
    this.emit('job', job); this.emit('change', this.list());
    void task(put).then(() => put({ phase: 'done', message: '完成', progress: 1 }), e => put({ phase: 'failed', error: String((e as Error)?.message ?? e).slice(0, 300) }));
    return job;
  }
}
