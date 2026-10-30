import os from "node:os";

export interface DesktopDeviceProfile {
  hostname: string;
  platform: string;
}

export function collectDesktopDeviceProfile(): DesktopDeviceProfile {
  const hostname = os.hostname().trim();
  return {
    hostname: hostname || "Desktop",
    platform: `${process.platform} ${os.release()}`.trim(),
  };
}

export function desktopDeviceMetadata(profile: DesktopDeviceProfile): Record<string, string> {
  return {
    hostname: profile.hostname,
    platform: profile.platform,
  };
}

export function defaultDesktopDeviceName(
  profile: DesktopDeviceProfile = collectDesktopDeviceProfile(),
): string {
  return profile.hostname.trim() || "Mori Desktop";
}
