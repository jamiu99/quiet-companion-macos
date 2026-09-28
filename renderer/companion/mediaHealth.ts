export interface VideoProgressSample {
  width: number; height: number; readyState: number; decodedFrames?: number; currentTime: number;
}
/** readyState=4 only means buffered data exists, NOT that new pictures arrive. Real RTC freezes can keep it at 4. */
export class MediaProgress {
  private lastFrames?: number;
  private lastTime?: number;
  private lastProgressAt: number;
  constructor(now: number) { this.lastProgressAt = now; }
  observe(frame: VideoProgressSample, now: number) {
    const valid = frame.width >= 64 && frame.height >= 64 && frame.readyState >= 2;
    const advanced = valid && (frame.decodedFrames !== undefined
      ? this.lastFrames === undefined || frame.decodedFrames !== this.lastFrames
      : this.lastTime === undefined || Math.abs(frame.currentTime - this.lastTime) >= 1 / 30);
    if (valid) { this.lastFrames = frame.decodedFrames; this.lastTime = frame.currentTime; }
    if (advanced) this.lastProgressAt = now;
    return { advanced, ageMs: Math.max(0, now - this.lastProgressAt) };
  }
}
