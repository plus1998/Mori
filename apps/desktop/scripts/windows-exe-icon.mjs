import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as ResEdit from "resedit";

// Pure JS resource editing keeps Mac cross builds independent of Wine/rcedit.
// Record executable section RVAs/bytes so an icon update cannot silently move
// or alter the code to which the native focus profile is pinned.
export function windowsExecutableCodeIdentity(bytes) {
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString("ascii", 0, 2) !== "MZ" || bytes.readUInt32LE(pe) !== 0x4550) throw new Error("Invalid Windows executable");
  const count = bytes.readUInt16LE(pe + 6);
  const start = pe + 24 + bytes.readUInt16LE(pe + 20);
  const sections = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * 40;
    if (!(bytes.readUInt32LE(at + 36) & 0x20000000)) continue;
    const size = bytes.readUInt32LE(at + 16), raw = bytes.readUInt32LE(at + 20);
    sections.push({ name: bytes.toString("ascii", at, at + 8).replace(/\0.*$/, ""),
      rva: bytes.readUInt32LE(at + 12), virtualSize: bytes.readUInt32LE(at + 8),
      sha256: createHash("sha256").update(bytes.subarray(raw, raw + size)).digest("hex") });
  }
  if (!sections.length) throw new Error("Windows executable has no code sections");
  return JSON.stringify(sections);
}

export function setWindowsExecutableIcon(exePath, iconPath) {
  const original = readFileSync(exePath);
  const identity = windowsExecutableCodeIdentity(original);
  const executable = ResEdit.NtExecutable.from(original, { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(executable);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const group = groups[0] ?? { id: 1, lang: 1033 };
  const icon = ResEdit.Data.IconFile.from(readFileSync(iconPath));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icon.icons.map(item => item.data));
  resources.outputResource(executable);
  const updated = Buffer.from(executable.generate());
  if (windowsExecutableCodeIdentity(updated) !== identity) throw new Error("Windows icon update altered executable code; refusing to write it");
  writeFileSync(exePath, updated);
}
