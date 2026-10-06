import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MOBILE_DRAWER_SWIPE_MIN_DISTANCE,
  resolveMobileDrawerSwipe,
  type MobileDrawerSwipeInput,
} from "../src/mobile-drawer-swipe";

const openFromEdge: MobileDrawerSwipeInput = {
  drawerWasOpen: false,
  startedInDrawer: false,
  listRoute: true,
  startX: 32,
  startY: 300,
  endX: 112,
  endY: 306,
  viewportWidth: 390,
};

test("opens the drawer on a deliberate rightward swipe from the inner left-edge band", () => {
  assert.equal(resolveMobileDrawerSwipe(openFromEdge), "open");
});

test("preserves browser edge-back gestures and ignores swipes starting away from the edge", () => {
  assert.equal(resolveMobileDrawerSwipe({ ...openFromEdge, startX: 8, endX: 92 }), null);
  assert.equal(resolveMobileDrawerSwipe({ ...openFromEdge, startX: 90, endX: 174 }), null);
});

test("does not open over a detail screen or for a leftward swipe", () => {
  assert.equal(resolveMobileDrawerSwipe({ ...openFromEdge, listRoute: false }), null);
  assert.equal(resolveMobileDrawerSwipe({ ...openFromEdge, startX: 64, endX: 8 }), null);
});

test("vertical, diagonal, and short gestures remain available to scrolling and taps", () => {
  assert.equal(resolveMobileDrawerSwipe({ ...openFromEdge, endX: 50, endY: 392 }), null);
  assert.equal(resolveMobileDrawerSwipe({ ...openFromEdge, endX: 70, endY: 380 }), null);
  assert.equal(resolveMobileDrawerSwipe({ ...openFromEdge, endX: 32 + MOBILE_DRAWER_SWIPE_MIN_DISTANCE - 1 }), null);
});

test("closes only on a deliberate leftward swipe that begins inside the open drawer", () => {
  const closeFromDrawer: MobileDrawerSwipeInput = {
    drawerWasOpen: true,
    startedInDrawer: true,
    listRoute: true,
    startX: 260,
    startY: 300,
    endX: 180,
    endY: 304,
    viewportWidth: 390,
  };
  assert.equal(resolveMobileDrawerSwipe(closeFromDrawer), "close");
  assert.equal(resolveMobileDrawerSwipe({ ...closeFromDrawer, startedInDrawer: false }), null);
  assert.equal(resolveMobileDrawerSwipe({ ...closeFromDrawer, endX: 330 }), null);
  assert.equal(resolveMobileDrawerSwipe({ ...closeFromDrawer, endX: 260 + MOBILE_DRAWER_SWIPE_MIN_DISTANCE - 1 }), null);
});

test("does not attach drawer swipes at desktop widths", () => {
  assert.equal(resolveMobileDrawerSwipe({ ...openFromEdge, viewportWidth: 1024 }), null);
});
