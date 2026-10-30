// Electron 45.1.0 official Windows x64 binary. Addresses come from its matching
// Breakpad symbols, checked against the PE code and CodeView/PDB identity.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "platform.h"

#if !defined(_M_X64) && !defined(__x86_64__)
#error Windows focus isolation supports x64 only
#endif

static DWORD ui_thread;
static char identity_error[256];
int mori_focus_is_ui_thread(void) { return ui_thread == 0 || GetCurrentThreadId() == ui_thread; }
static int platform_fail(const char **error, const char *message) { *error = message; return -1; }

int mori_focus_resolve(void **focus_address, void **filter_address, const char **error) {
  const uint8_t expected_pdb_guid[16] = {
    0x41,0x18,0xf2,0x15,0xf0,0xa0,0x15,0x45,0x4c,0x4c,0x44,0x20,0x50,0x44,0x42,0x2e
  };
  const uint8_t focus_signature[24] = {
    0x56,0x48,0x83,0xec,0x50,0x48,0x89,0xce,0x48,0x8b,0x05,0xa1,
    0x3d,0x16,0x08,0x48,0x31,0xe0,0x48,0x89,0x44,0x24,0x48,0x48
  };
  const uint8_t filter_signature[24] = {
    0x56,0x57,0x53,0x48,0x83,0xec,0x20,0x48,0x89,0xd6,0x48,0x89,
    0xcf,0x48,0x8d,0x0d,0x8c,0xaf,0x4f,0x0d,0xe8,0x87,0x5e,0xc3
  };
  const uint32_t focus_rva = 0x6526290, filter_rva = 0x11bd810;
  uint8_t *image = (uint8_t *)GetModuleHandleW(NULL);
  if (!image) return platform_fail(error, "Cannot find the Electron executable module");
  const IMAGE_DOS_HEADER *dos = (const void *)image;
  if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 0 || dos->e_lfanew > 0x100000)
    return platform_fail(error, "Invalid Electron PE header");
  const IMAGE_NT_HEADERS64 *nt = (const void *)(image + dos->e_lfanew);
  if (nt->Signature != IMAGE_NT_SIGNATURE || nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
      nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC)
    return platform_fail(error, "Electron executable is not Windows x64 PE32+");
  uint32_t image_size = nt->OptionalHeader.SizeOfImage;
  if (focus_rva + sizeof(focus_signature) > image_size || filter_rva + sizeof(filter_signature) > image_size)
    return platform_fail(error, "Electron focus addresses are outside the executable image");

  // Renaming the EXE, changing its icon/resources, or Authenticode signing can
  // change its file hash/size. The matching PDB GUID+age and code bytes survive.
  IMAGE_DATA_DIRECTORY debug = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DEBUG];
  if (debug.VirtualAddress > image_size || debug.Size > image_size - debug.VirtualAddress)
    return platform_fail(error, "Invalid Electron PE debug directory");
  const IMAGE_DEBUG_DIRECTORY *entries = (const void *)(image + debug.VirtualAddress);
  int matched = 0;
  for (uint32_t i = 0; i < debug.Size / sizeof(*entries); ++i) {
    const IMAGE_DEBUG_DIRECTORY *entry = &entries[i];
    if (entry->Type != IMAGE_DEBUG_TYPE_CODEVIEW || entry->SizeOfData < 24 ||
        entry->AddressOfRawData > image_size || entry->SizeOfData > image_size - entry->AddressOfRawData)
      continue;
    const uint8_t *record = image + entry->AddressOfRawData;
    if (memcmp(record, "RSDS", 4) != 0) continue;
    uint32_t age;
    memcpy(&age, record + 20, sizeof(age));
    if (memcmp(record + 4, expected_pdb_guid, 16) == 0 && age == 1) matched = 1;
    else snprintf(identity_error, sizeof(identity_error),
      "Electron PDB identity mismatch (age=%lu, GUID bytes=%02x%02x%02x%02x...); native Agent clicks disabled",
      (unsigned long)age, record[4], record[5], record[6], record[7]);
  }
  if (!matched) return platform_fail(error, identity_error[0] ? identity_error : "Electron PDB identity missing; native Agent clicks disabled");

  const IMAGE_SECTION_HEADER *section = IMAGE_FIRST_SECTION(nt);
  int focus_executable = 0, filter_executable = 0;
  for (unsigned i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++section) {
    if (!(section->Characteristics & IMAGE_SCN_MEM_EXECUTE)) continue;
    uint64_t begin = section->VirtualAddress, end = begin + section->Misc.VirtualSize;
    if (focus_rva >= begin && focus_rva + sizeof(focus_signature) <= end) focus_executable = 1;
    if (filter_rva >= begin && filter_rva + sizeof(filter_signature) <= end) filter_executable = 1;
  }
  if (!focus_executable || !filter_executable)
    return platform_fail(error, "Electron focus addresses are not in executable sections");
  if (memcmp(image + focus_rva, focus_signature, sizeof(focus_signature)) != 0 ||
      memcmp(image + filter_rva, filter_signature, sizeof(filter_signature)) != 0)
    return platform_fail(error, "Electron focus/event-router instructions mismatch; native Agent clicks disabled");
  *focus_address = image + focus_rva;
  *filter_address = image + filter_rva;
  ui_thread = GetCurrentThreadId();
  return 0;
}
