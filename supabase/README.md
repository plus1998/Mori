# Mori Supabase Center

Schema and Edge Functions for identity, device binding, Realtime RPC,
account-scoped settings sync (password-wrapped vault), and HTML Artifacts hosting.

- **Deploy Cloud:** [docs/supabase-deploy.md](../docs/supabase-deploy.md)
- **Self-host Docker:** [docs/supabase-self-host.md](../docs/supabase-self-host.md)
- **Agent skill:** [.agents/skills/mori-supabase/SKILL.md](../.agents/skills/mori-supabase/SKILL.md)
- **Design:** [docs/superpowers/specs/2026-08-20-supabase-center-design.md](../docs/superpowers/specs/2026-08-20-supabase-center-design.md)

## Client setup

Desktop / Mobile require:

- `supabaseUrl` — project URL (Cloud or self-hosted gateway)
- `anonKey` — anon public key

There is no official Mori-hosted node.

**Never** ship `service_role` to Desktop/Mobile.

Primary UX: same-account email/password login discovers registered PCs.
Connect QR is `mori://center?supabase=...&anon=...` (server bootstrap only).
Current desktop and mobile clients also accept legacy `eco://` links. Update mobile clients before scanning new `mori://` QR codes or deploying the updated pairing functions; older clients do not recognize the new scheme. Existing account and device bindings are unchanged.

### HTML hosting (Artifacts)

Edge Functions `html-host-probe` / `html-page-publish` / `html-page-view` / `html-page-extend`
store single-file HTML in Postgres and serve it with Mori chrome.

**Cloud note:** without a Custom Domain, shared hosts may rewrite `text/html` to `text/plain`, so share links may not render. Mori still enables publishing and shows a warning in Settings.
## Quick commands

```sh
# Interactive wizard (pick platform / first-time vs update)
bun run supabase:deploy

# Cloud
npx supabase login
bun run supabase:deploy -- --platform cloud --project-ref <project-ref>

# Self-hosted Docker (compose dir = official supabase-project)
bun run supabase:deploy -- --platform self-host --compose-dir /path/to/supabase-project

# Local CLI stack
npx supabase start && npx supabase db reset
npx supabase functions serve
```

## Edge Functions (Track A)

Expect `Authorization: Bearer <user access_token>` (Supabase Auth JWT) and
`apikey: <anonKey>`. Responses never include `secret_hash` / `code_hash` /
`bootstrap_token_hash`.

Base URL: `{supabaseUrl}/functions/v1`

### `device-register`

Registers a device for the signed-in user. Returns `deviceSecret` **once**.

```sh
curl -sS -X POST "$SUPABASE_URL/functions/v1/device-register" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kind":"desktop","name":"My Mac","metadata":{"platform":"darwin"}}'
```

Body: `{ "kind": "desktop"|"mobile", "name": string, "metadata"?: object }`  
Response `201`: `{ "device": { id, userId, kind, name, metadata, createdAt, ... }, "deviceSecret": "..." }`

### `device-session-register`

Desktop/Mobile 用 `deviceSecret` 证明设备身份，把当前 Supabase Auth `session_id`
绑定到该设备。客户端在加入 private Realtime channel 前调用，并在 token refresh / 定期
revalidation 时重复调用。Body：`{ "deviceId", "deviceSecret", "kind" }`。

设备级 RLS 强制策略单独放在
`deferred-migrations/20260822102000_enforce_device_sessions.sql`。先发布支持该函数的客户端并
等待设备重新连接，再人工执行；不要把它并入首次基础设施 rollout。

### `binding-ensure`（主路径）

同账号 Mobile 选中 Desktop 后建立或恢复 `device_bindings`（无需配对码）。

```sh
curl -sS -X POST "$SUPABASE_URL/functions/v1/binding-ensure" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "mobileDeviceId":"'"$MOBILE_DEVICE_ID"'",
    "deviceSecret":"'"$MOBILE_SECRET"'",
    "desktopDeviceId":"'"$DESKTOP_DEVICE_ID"'"
  }'
```

Response: `{ "binding", "desktopDeviceId" }`

### `pairing-create` / `pairing-join`（遗留）

旧客户端配对码路径仍部署；新产品主路径不再调用。Prefer `binding-ensure`。

### Vault password wrap

Table `user_vault_wraps` stores PBKDF2-SHA256 + AES-GCM ciphertext of `vault_key`
under the account login password (client-side crypto, RLS by `user_id`).
Changing Auth password without re-wrapping on a device that holds `vault_key`
leaves the wrap unlockable only with the old password.
