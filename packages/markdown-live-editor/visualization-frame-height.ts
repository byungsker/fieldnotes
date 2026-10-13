export const INITIAL_VISUALIZATION_FRAME_HEIGHT = 320;
export const MAX_VISUALIZATION_FRAME_HEIGHT = 16_000;

export function boundedVisualizationFrameHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(MAX_VISUALIZATION_FRAME_HEIGHT, Math.max(160, Math.ceil(value)));
}
