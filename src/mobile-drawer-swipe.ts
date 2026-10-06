export type MobileDrawerSwipeDirection = "open" | "close";

export type MobileDrawerSwipeInput = {
  drawerWasOpen: boolean;
  startedInDrawer: boolean;
  listRoute: boolean;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  viewportWidth: number;
};

export type MobileDrawerSwipeDragInput = Omit<MobileDrawerSwipeInput, "endX" | "endY"> & {
  currentX: number;
  currentY: number;
};

export type MobileDrawerSwipeDrag = {
  direction: MobileDrawerSwipeDirection;
  progress: number;
  deltaX: number;
};

export const MOBILE_DRAWER_SWIPE_MIN_DISTANCE = 56;
export const MOBILE_DRAWER_SWIPE_EDGE_MIN = 20;
export const MOBILE_DRAWER_SWIPE_EDGE_MAX = 64;
export const MOBILE_DRAWER_SWIPE_AXIS_RATIO = 1.25;

export function resolveMobileDrawerSwipe(input: MobileDrawerSwipeInput): MobileDrawerSwipeDirection | null {
  if (input.viewportWidth > 820) return null;

  const deltaX = input.endX - input.startX;
  const deltaY = input.endY - input.startY;
  const horizontalDistance = Math.abs(deltaX);
  if (
    horizontalDistance < MOBILE_DRAWER_SWIPE_MIN_DISTANCE ||
    horizontalDistance < Math.abs(deltaY) * MOBILE_DRAWER_SWIPE_AXIS_RATIO
  ) {
    return null;
  }

  if (input.drawerWasOpen) {
    return input.startedInDrawer && input.startX >= MOBILE_DRAWER_SWIPE_EDGE_MIN && deltaX < 0 ? "close" : null;
  }

  const beganNearLeftEdge = input.startX >= MOBILE_DRAWER_SWIPE_EDGE_MIN &&
    input.startX <= Math.min(MOBILE_DRAWER_SWIPE_EDGE_MAX, input.viewportWidth * 0.2);
  return input.listRoute && beganNearLeftEdge && deltaX > 0 ? "open" : null;
}

export function resolveMobileDrawerSwipeDrag(input: MobileDrawerSwipeDragInput): MobileDrawerSwipeDrag | null {
  if (input.viewportWidth > 820) return null;
  const deltaX = input.currentX - input.startX;
  const deltaY = input.currentY - input.startY;
  if (Math.abs(deltaX) < 8 || Math.abs(deltaX) < Math.abs(deltaY) * MOBILE_DRAWER_SWIPE_AXIS_RATIO) return null;

  let direction: MobileDrawerSwipeDirection;
  if (input.drawerWasOpen) {
    if (!input.startedInDrawer || input.startX < MOBILE_DRAWER_SWIPE_EDGE_MIN || deltaX >= 0) return null;
    direction = "close";
  } else {
    const beganNearLeftEdge = input.startX >= MOBILE_DRAWER_SWIPE_EDGE_MIN &&
      input.startX <= Math.min(MOBILE_DRAWER_SWIPE_EDGE_MAX, input.viewportWidth * 0.2);
    if (!input.listRoute || !beganNearLeftEdge || deltaX <= 0) return null;
    direction = "open";
  }

  return {
    direction,
    deltaX,
    progress: Math.min(1, Math.abs(deltaX) / input.viewportWidth),
  };
}
