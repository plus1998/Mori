import type { net, Session } from "electron";
import { z } from "zod";
import type { CursorAccountQuotaResult } from "../shared/ipc";

const percent = z.number().finite().nonnegative().optional();
const usageSummary = z.object({
  membershipType: z.string().min(1),
  billingCycleEnd: z.iso.datetime({ offset: true }).nullish(),
  individualUsage: z.object({
    plan: z.object({
      totalPercentUsed: percent,
      autoPercentUsed: percent,
      apiPercentUsed: percent,
      limit: z.number().nullish(),
    }).nullish(),
  }).nullish(),
});

export function parseCursorUsageSummary(raw: string): CursorAccountQuotaResult {
  try {
    const { membershipType, billingCycleEnd, individualUsage } = usageSummary.parse(JSON.parse(raw));
    const plan = individualUsage?.plan;
    const buckets = ([
      ["total", plan?.totalPercentUsed],
      ["auto", plan?.autoPercentUsed],
      ["api", membershipType === "free" && plan?.limit === 0 ? undefined : plan?.apiPercentUsed],
    ] as const).flatMap(([kind, usedPercent]) => usedPercent === undefined ? [] : [{ kind, usedPercent }]);
    if (!buckets.length) return { ok: false, code: "quotaUnavailable" };
    return {
      ok: true,
      quota: {
        planType: membershipType,
        fetchedAt: Date.now(),
        ...(billingCycleEnd ? { resetAt: Date.parse(billingCycleEnd) } : {}),
        buckets,
      },
    };
  } catch {
    return { ok: false, code: "quotaInvalidResponse" };
  }
}

export function queryCursorAccountQuota(
  createRequest: typeof net.request,
  session: Session,
  proxyCredentials: (info: Electron.AuthInfo) => [string, string] | undefined,
): Promise<CursorAccountQuotaResult> {
  return new Promise((resolve) => {
    const request = createRequest({
      url: "https://cursor.com/api/usage-summary",
      session,
      useSessionCookies: true,
      redirect: "manual",
    });
    const finish = (result: CursorAccountQuotaResult) => {
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      finish({ ok: false, code: "quotaTimeout" });
      request.abort();
    }, 20_000);
    request.setHeader("Accept", "application/json");
    request.setHeader("Cache-Control", "no-cache");
    request.once("login", (info, callback) => {
      const credentials = proxyCredentials(info);
      if (credentials) callback(...credentials);
      else callback();
    });
    request.on("redirect", () => {
      finish({ ok: false, code: "quotaInvalidResponse" });
      request.abort();
    });
    request.on("error", () => finish({ ok: false, code: "quotaRequestFailed" }));
    request.on("response", (response) => {
      response.on("error", () => finish({ ok: false, code: "quotaRequestFailed" }));
      if (response.statusCode !== 200) {
        finish(response.statusCode === 401
          ? { ok: false, code: "quotaLoginRequired" }
          : { ok: false, code: "quotaHttpError", status: response.statusCode });
        request.abort();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          finish({ ok: false, code: "quotaInvalidResponse" });
          request.abort();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(parseCursorUsageSummary(Buffer.concat(chunks).toString("utf8"))));
    });
    request.end();
  });
}
