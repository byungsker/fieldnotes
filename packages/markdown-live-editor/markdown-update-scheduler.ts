export type AnimationFrameRequest = (callback: FrameRequestCallback) => number;
export type AnimationFrameCancel = (handle: number) => void;

/** Coalesce rich-editor serialization work to at most once per paint. */
export class MarkdownUpdateScheduler<T> {
  private pending: T | null = null;
  private frame: number | null = null;

  constructor(
    private readonly update: (value: T) => void,
    private readonly requestFrame: AnimationFrameRequest,
    private readonly cancelFrame: AnimationFrameCancel,
  ) {}

  schedule(value: T): void {
    this.pending = value;
    if (this.frame !== null) return;
    this.frame = this.requestFrame(() => {
      this.frame = null;
      const pending = this.pending;
      this.pending = null;
      if (pending !== null) this.update(pending);
    });
  }

  flush(value?: T, force = false): void {
    const pending = this.pending;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.pending = null;
    const latest = value ?? pending;
    if (latest !== null && latest !== undefined && (force || pending !== null)) this.update(latest);
  }
}
