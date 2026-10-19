export const DESKTOP_SIDEBAR_MIN_WIDTH = 200;
export const DESKTOP_SIDEBAR_MAX_WIDTH = 420;

export function clampDesktopSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DESKTOP_SIDEBAR_MIN_WIDTH;
  return Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, Math.max(DESKTOP_SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function normalizeDesktopSidebarWidth(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return clampDesktopSidebarWidth(parsed);
}
