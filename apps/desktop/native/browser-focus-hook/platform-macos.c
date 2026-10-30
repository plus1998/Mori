#include "platform.h"
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <pthread.h>
#include <stdint.h>
#include <string.h>

int mori_focus_is_ui_thread(void) { return pthread_main_np(); }
static int platform_fail(const char **error, const char *message) { *error = message; return -1; }

int mori_focus_resolve(void **focus_address, void **filter_address, const char **error) {
  // LC_UUID identifies the exact framework build; ASLR and re-signing do not change it.
  const uint8_t expected_uuid[16] = {
    0x4c,0x4c,0x44,0x0d,0x55,0x55,0x31,0x44,0xa1,0xd2,0x90,0x5e,0x01,0x04,0x38,0xe6
  };
  const uint8_t signature[16] = {
    0xff,0x03,0x01,0xd1,0xf4,0x4f,0x02,0xa9,0xfd,0x7b,0x03,0xa9,0xfd,0xc3,0x00,0x91
  };
  const uint8_t filter_signature[16] = {
    0xf4,0x4f,0xbe,0xa9,0xfd,0x7b,0x01,0xa9,0xfd,0x43,0x00,0x91,0xf3,0x03,0x01,0xaa
  };
  const uintptr_t rva = 0x5059a80, filter_rva = 0x703396c;
  const struct mach_header_64 *header = NULL;
  for (uint32_t i = 0; i < _dyld_image_count(); ++i) {
    const char *name = _dyld_get_image_name(i);
    const char suffix[] = "/Electron Framework.framework/Versions/A/Electron Framework";
    size_t length = strlen(name), suffix_length = sizeof(suffix) - 1;
    if (length >= suffix_length && strcmp(name + length - suffix_length, suffix) == 0) {
      header = (const struct mach_header_64 *)_dyld_get_image_header(i);
      break;
    }
  }
  if (!header || header->magic != MH_MAGIC_64 || header->cputype != CPU_TYPE_ARM64)
    return platform_fail(error, "Unsupported Electron Framework image/architecture");
  const struct load_command *command = (const void *)(header + 1);
  int uuid_matches = 0, address_in_text = 0;
  for (uint32_t i = 0; i < header->ncmds; ++i) {
    if (command->cmd == LC_UUID)
      uuid_matches = memcmp(((const struct uuid_command *)command)->uuid, expected_uuid, 16) == 0;
    if (command->cmd == LC_SEGMENT_64) {
      const struct segment_command_64 *segment = (const void *)command;
      if (strcmp(segment->segname, "__TEXT") == 0)
        address_in_text = rva >= segment->vmaddr && rva + sizeof(signature) <= segment->vmaddr + segment->vmsize &&
          filter_rva >= segment->vmaddr && filter_rva + sizeof(filter_signature) <= segment->vmaddr + segment->vmsize;
    }
    command = (const void *)((const uint8_t *)command + command->cmdsize);
  }
  if (!uuid_matches || !address_in_text)
    return platform_fail(error, "Electron Framework build fingerprint mismatch; native Agent clicks are disabled");
  *focus_address = (uint8_t *)header + rva;
  if (memcmp(*focus_address, signature, sizeof(signature)) != 0)
    return platform_fail(error, "Electron focus function signature mismatch; native Agent clicks are disabled");

  *filter_address = (uint8_t *)header + filter_rva;
  if (memcmp(*filter_address, filter_signature, sizeof(filter_signature)) != 0)
    return platform_fail(error, "Electron event router signature mismatch; native Agent clicks are disabled");

  return 0;
}
