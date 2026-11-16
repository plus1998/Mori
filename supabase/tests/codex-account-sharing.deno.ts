// Embedded Postgres exercises the actual migration/RLS without a Cloud account.
// deno test --allow-read --allow-env --allow-sys --no-lock --node-modules-dir=none supabase/tests/codex-account-sharing.deno.ts
import { PGlite } from "npm:@electric-sql/pglite@0.5.16";

const migration = await Deno.readTextFile(
  new URL("../migrations/20261116120000_codex_account_sharing.sql", import.meta.url),
);
const uid = "10000000-0000-4000-8000-000000000001";
const outsider = "10000000-0000-4000-8000-000000000002";
const host = "20000000-0000-4000-8000-000000000001";
const pc = "20000000-0000-4000-8000-000000000002";
const otherPc = "20000000-0000-4000-8000-000000000003";
const mobile = "20000000-0000-4000-8000-000000000004";
const outsiderPc = "20000000-0000-4000-8000-000000000005";
const session = (device: string) => device.replace("20000000", "30000000");
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("PC grants enforce device ownership, private topics, revocation and new grant epochs", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create schema realtime;
      grant usage on schema public, auth, realtime to authenticated;
      create table auth.users(id uuid primary key);
      create table public.devices(id uuid primary key, user_id uuid, kind text, disabled_at timestamptz);
      create table public.device_sessions(session_id uuid primary key, user_id uuid, device_id uuid);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.sub', true), '')::uuid $$;
      create function public.eco_current_device_id() returns uuid language sql stable security definer set search_path = '' as $$
        select ds.device_id from public.device_sessions ds join public.devices d on d.id = ds.device_id
          and d.user_id = ds.user_id and d.disabled_at is null
        where ds.session_id = nullif(current_setting('request.jwt.session_id', true), '')::uuid
          and ds.user_id = (select auth.uid()) limit 1
      $$;
      create function realtime.topic() returns text language sql stable as
        $$ select current_setting('realtime.topic', true) $$;
      create table realtime.messages(id uuid default gen_random_uuid(), payload text);
      alter table realtime.messages enable row level security;
      grant select, insert on realtime.messages to authenticated;
      insert into auth.users values ('${uid}'), ('${outsider}');
      insert into public.devices values
        ('${host}', '${uid}', 'desktop', null), ('${pc}', '${uid}', 'desktop', null),
        ('${otherPc}', '${uid}', 'desktop', null), ('${mobile}', '${uid}', 'mobile', null),
        ('${outsiderPc}', '${outsider}', 'desktop', null);
      insert into public.device_sessions select replace(id::text, '20000000', '30000000')::uuid, user_id, id from public.devices;
    `);
    await db.exec(migration);
    const identity = async (device: string, user = uid) => {
      await db.exec(`reset role; set role authenticated;
        select set_config('request.jwt.sub', '${user}', false);
        select set_config('request.jwt.session_id', '${session(device)}', false);`);
    };
    const shareWith = (recipients: string[]) =>
      db.query("select public.eco_set_codex_account_shares($1, $2, $3, $4::uuid[])", [
        "oa_work",
        "Work account",
        "chatgpt-work",
        recipients,
      ]);
    const denied = async (work: () => Promise<unknown>) => {
      let code = "";
      try {
        await work();
      } catch (error) {
        code = String((error as { code?: string }).code);
      }
      assert(code === "42501", `expected permission denial, received ${code || "success"}`);
    };

    await identity(host);
    await shareWith([pc]);
    const row = (
      await db.query<{ id: string; grant_epoch: string }>(
        "select id, grant_epoch from public.codex_account_shares",
      )
    ).rows[0]!;
    const topic = `eco:codex:${row.id}`;
    await db.query("select set_config('realtime.topic', $1, false)", [topic]);
    await db.exec("insert into realtime.messages(payload) values ('access token response')");

    await identity(pc);
    assert(
      (await db.query("select * from public.codex_account_shares")).rows.length === 1,
      "recipient sees its grant",
    );
    assert(
      (await db.query("select * from realtime.messages")).rows.length === 1,
      "recipient can receive on its private topic",
    );
    await denied(() => db.exec("update public.codex_account_shares set revoked_at = null"));

    await identity(otherPc);
    assert(
      (await db.query("select * from public.codex_account_shares")).rows.length === 0,
      "same user does not grant access to another PC's share",
    );
    assert(
      (await db.query("select * from realtime.messages")).rows.length === 0,
      "ungranted PC cannot read tokens",
    );
    await denied(() => db.exec("insert into realtime.messages(payload) values ('forged request')"));
    await identity(host);
    await denied(() => shareWith([outsiderPc]));
    await denied(() => shareWith([mobile]));
    await identity(mobile);
    await denied(() => shareWith([pc]));
    await identity(outsiderPc, outsider);
    assert(
      (await db.query("select * from public.codex_account_shares")).rows.length === 0,
      "other user cannot discover grants",
    );

    await identity(host);
    await shareWith([]);
    await identity(pc);
    assert(
      (await db.query("select * from realtime.messages")).rows.length === 0,
      "revocation blocks topic access",
    );
    await denied(() => db.exec("insert into realtime.messages(payload) values ('revoked request')"));
    await identity(host);
    await shareWith([pc]);
    const renewed = (
      await db.query<{ grant_epoch: string }>("select grant_epoch from public.codex_account_shares")
    ).rows[0]!;
    assert(
      renewed.grant_epoch !== row.grant_epoch,
      "regrant invalidates old requests and cached credentials",
    );
    await db.exec(`reset role; update public.devices set disabled_at = now() where id = '${pc}'`);
    await identity(pc);
    assert(
      (await db.query("select * from public.codex_account_shares")).rows.length === 0,
      "disabled device loses grant visibility",
    );
    assert(
      (await db.query("select * from realtime.messages")).rows.length === 0,
      "disabled device loses topic access",
    );
  } finally {
    await db.close();
  }
});
