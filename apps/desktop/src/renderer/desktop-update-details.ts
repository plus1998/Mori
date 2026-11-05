import type { DesktopUpdateState } from "../shared/desktop-update";

export function desktopUpdateDetails(state: DesktopUpdateState, now: number) {
  const progress = state.progress;
  const finitePositive = (value: number | undefined) => Number.isFinite(value) && value! > 0 ? value! : 0;
  const total = finitePositive(progress?.total);
  const transferred = finitePositive(progress?.transferred);
  const lastProgressAt = state.progressUpdatedAt ?? state.phaseStartedAt ?? now;
  const stalled = state.phase === "downloading" && now - lastProgressAt >= 15_000;
  const bytesPerSecond = stalled ? 0 : finitePositive(progress?.bytesPerSecond);
  const remaining = total > transferred ? total - transferred : 0;
  return {
    total, transferred, bytesPerSecond, stalled,
    percent: Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, Math.floor(progress!.percent))) : 0,
    remainingSeconds: remaining > 0 && bytesPerSecond > 0 ? Math.ceil(remaining / bytesPerSecond) : undefined,
    elapsedSeconds: Math.max(0, Math.floor((now - (state.phaseStartedAt ?? now)) / 1000)),
  };
}

export function updateClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function updateBytes(bytes: number, locale: string): string {
  const unit = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${["B", "KB", "MB", "GB"][unit]}`;
}
