#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <string.h>

// Electron 45.1.0 / Chromium 156 shares one reentrancy flag between two
// AppKit callbacks that can legitimately call one another after a window drag.
// https://github.com/electron/electron/issues/55518
// https://chromium-review.googlesource.com/c/chromium/src/+/8535166
static char fixedWindowKey;
static ptrdiff_t adjustmentFlagOffset;
typedef void (*AfterMove)(NSWindow *, SEL, NSRect);
typedef void (*AdjustFrame)(NSWindow *, SEL, NSRect, NSScreen *, const CGPoint *, BOOL);
static AfterMove originalAfterMove;
static AdjustFrame originalAdjust;

// AppKit calls these methods on the main thread. Keep the context on the stack
// so callbacks on a different window can still run while a move is in progress.
struct MoveContext {
  __unsafe_unretained NSWindow *window;
  struct MoveContext *previous;
  BOOL adjusting;
};
static struct MoveContext *currentMove;

static void afterMove(NSWindow *window, SEL selector, NSRect frame) {
  if (!objc_getAssociatedObject(window, &fixedWindowKey)) {
    originalAfterMove(window, selector, frame);
    return;
  }
  for (struct MoveContext *move = currentMove; move; move = move->previous) {
    if (move->window == window) return;
  }
  struct MoveContext move = { window, currentMove, NO };
  currentMove = &move;
  @try {
    originalAfterMove(window, selector, frame);
  } @finally {
    currentMove = move.previous;
  }
}

static void adjust(NSWindow *window, SEL selector, NSRect frame,
                   NSScreen *screen, const CGPoint *anchor, BOOL animate) {
  struct MoveContext *move = currentMove;
  while (move && move->window != window) move = move->previous;
  if (!move || move->adjusting) {
    originalAdjust(window, selector, frame, screen, anchor, animate);
    return;
  }

  // Allow the nested adjustment while retaining Chromium's own checks for
  // headless windows, move loops and recursive adjustment.
  BOOL *flag = (BOOL *)((char *)(__bridge void *)window + adjustmentFlagOffset);
  BOOL previousFlag = *flag;
  *flag = NO;
  move->adjusting = YES;
  @try {
    originalAdjust(window, selector, frame, screen, anchor, animate);
  } @finally {
    move->adjusting = NO;
    *flag = previousFlag;
  }
}

__attribute__((visibility("default")))
const char *mori_fix_mac_window_frame(void *nativeView) {
  SEL afterMoveSelector = sel_registerName("_setFrameAfterMove:");
  SEL adjustSelector = sel_registerName("_setFrame:fromAdjustmentToScreen:anchorIfNeeded:animate:");
  if (![NSWindow instancesRespondToSelector:afterMoveSelector] ||
      ![NSWindow instancesRespondToSelector:adjustSelector]) return NULL;

  NSWindow *window = [(__bridge NSView *)nativeView window];
  Class electronWindow = objc_getClass("NativeWidgetMacNSWindow");
  if (!electronWindow || ![window isKindOfClass:electronWindow]) {
    return "Unexpected Electron native window class";
  }
  if (!originalAfterMove) {
    Ivar flag = class_getInstanceVariable(electronWindow, "_inSetFrameFromAdjustment");
    Method moveMethod = class_getInstanceMethod(electronWindow, afterMoveSelector);
    Method adjustMethod = class_getInstanceMethod(electronWindow, adjustSelector);
    if (!flag || strcmp(ivar_getTypeEncoding(flag), @encode(BOOL)) != 0 ||
        !moveMethod || moveMethod == class_getInstanceMethod(NSWindow.class, afterMoveSelector) ||
        !adjustMethod || adjustMethod == class_getInstanceMethod(NSWindow.class, adjustSelector)) {
      return "Electron window frame adjustment methods do not match the pinned Chromium build";
    }
    adjustmentFlagOffset = ivar_getOffset(flag);
    originalAfterMove = (AfterMove)method_setImplementation(moveMethod, (IMP)afterMove);
    originalAdjust = (AdjustFrame)method_setImplementation(adjustMethod, (IMP)adjust);
  }
  objc_setAssociatedObject(window, &fixedWindowKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return NULL;
}
