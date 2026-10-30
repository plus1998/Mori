// Native focus isolation for pinned Electron 45.1.0 desktop builds.
// Classify each native event at dispatch time; CDP provenance survives async queues.
#include "frida-gum.h"
#include "platform.h"
#include <stdint.h>
#include <string.h>

typedef void (*FocusFunction)(void *, void *);
typedef int (*FilterFunction)(void *, const void *, const void *);
static GumInterceptor *interceptor;
static FocusFunction original_focus;
static FilterFunction original_filter;
static void *focus_address, *filter_address;
static int installed;
static int gum_initialized;
static MORI_THREAD_LOCAL unsigned filter_depth;
static MORI_THREAD_LOCAL int event_from_debugger;
static uint64_t blocked_count, allowed_count;
static const char *last_error = "";

#define API MORI_EXPORT
static int fail(const char *message) { last_error = message; return -1; }

static void isolated_focus(void *contents, void *widget) {
  if (event_from_debugger) {
    ++blocked_count;
    return;
  }
  ++allowed_count;
  original_focus(contents, widget);
}

// input::RenderInputRouter::FilterInputEvent calls OnInputEventPreDispatch
// synchronously. The WebInputEvent retains kFromDebugger even if CDP hit-testing
// queued it earlier. Physical user events do not have that native flag.
static int isolated_filter(void *router, const void *event, const void *latency) {
  uint32_t modifiers;
  memcpy(&modifiers, (const uint8_t *)event + 0x34, sizeof(modifiers));
  int previous = event_from_debugger;
  event_from_debugger = (modifiers & (1u << 23)) != 0;
  ++filter_depth;
  int result = original_filter(router, event, latency);
  --filter_depth;
  event_from_debugger = previous;
  return result;
}

API const char *mori_browser_focus_error(void) { return last_error; }

API int mori_browser_focus_install(void) {
  if (!mori_focus_is_ui_thread()) return fail("Focus Hook must be installed on the UI thread");
  if (installed) return 0;
  const char *resolve_error = "";
  if (mori_focus_resolve(&focus_address, &filter_address, &resolve_error) != 0)
    return fail(resolve_error);

  if (!gum_initialized) {
    gum_init_embedded();
    gum_initialized = 1;
  }
  interceptor = gum_interceptor_obtain();
  gum_interceptor_begin_transaction(interceptor);
  GumReplaceReturn result = gum_interceptor_replace(interceptor, focus_address,
    isolated_focus, NULL, (gpointer *)&original_focus);
  GumReplaceReturn filter_result = result == GUM_REPLACE_OK ? gum_interceptor_replace(
    interceptor, filter_address, isolated_filter, NULL, (gpointer *)&original_filter) : GUM_REPLACE_WRONG_SIGNATURE;
  if (result != GUM_REPLACE_OK || filter_result != GUM_REPLACE_OK) {
    if (result == GUM_REPLACE_OK) gum_interceptor_revert(interceptor, focus_address);
    gum_interceptor_end_transaction(interceptor);
    g_object_unref(interceptor);
    interceptor = NULL;
    return fail("Frida Gum could not install Electron input/focus interception");
  }
  gum_interceptor_end_transaction(interceptor);
  installed = 1;
  last_error = "";
  return 0;
}

API unsigned mori_browser_focus_depth(void) { return filter_depth; }
API uint64_t mori_browser_focus_blocked(void) { return blocked_count; }
API uint64_t mori_browser_focus_allowed(void) { return allowed_count; }

API int mori_browser_focus_uninstall(void) {
  if (!mori_focus_is_ui_thread() || filter_depth) return fail("Cannot remove Focus Hook during native input dispatch");
  if (!installed) return 0;
  gum_interceptor_revert(interceptor, filter_address);
  gum_interceptor_revert(interceptor, focus_address);
  if (!gum_interceptor_flush(interceptor)) return fail("Focus Hook still has active invocations");
  installed = 0;
  g_object_unref(interceptor);
  interceptor = NULL;
  // Keep the dylib and Gum runtime loaded until process exit; no callback can outlive them.
  return 0;
}
