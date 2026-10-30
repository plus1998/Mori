#pragma once

#ifdef _WIN32
#define MORI_EXPORT __declspec(dllexport)
#define MORI_THREAD_LOCAL __declspec(thread)
#else
#define MORI_EXPORT __attribute__((visibility("default")))
#define MORI_THREAD_LOCAL _Thread_local
#endif

int mori_focus_is_ui_thread(void);
int mori_focus_resolve(void **focus_address, void **filter_address, const char **error);
