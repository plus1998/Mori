import { useEffect, useState } from "react";

/** Only this label ticks; the surrounding Feed does not rerender every second. */
export function RetryCountdownLabel({ label, retryAt }: { label: string; retryAt: string }) {
  const deadline = Date.parse(retryAt);
  const [now, setNow] = useState(Date.now);
  const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    if (deadline <= Date.now()) return;
    const timer = setInterval(() => {
      tick();
      if (deadline <= Date.now()) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  return (
    <>
      {label}
      {remaining > 0 ? `。约 ${remaining} 秒后重试` : "。正在重试…"}
    </>
  );
}
