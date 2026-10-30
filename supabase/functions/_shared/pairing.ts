import { createPairingCode, createRandomToken, normalizePairingCode, sha256Hex } from "./crypto.ts";
import {
  DEFAULT_BINDING_CAPABILITIES,
  type DeviceRow,
  type PublicDevice,
  requireOwnedDevice,
  toPublicDevice,
} from "./devices.ts";
import { HttpError } from "./http.ts";
import type { AdminClient } from "./supabase.ts";

/** Matches legacy Center Server default (ECO_PAIRING_TTL_SECONDS). */
export const PAIRING_TTL_SECONDS = 5 * 60;

export interface PairingSessionRow {
  id: string;
  user_id: string;
  desktop_device_id: string;
  code_hash: string;
  bootstrap_token_hash: string;
  expires_at: string;
  claimed_at: string | null;
  created_at: string;
}

export interface DeviceBindingRow {
  id: string;
  user_id: string;
  desktop_device_id: string;
  mobile_device_id: string;
  capabilities: string[];
  created_at: string;
  revoked_at: string | null;
}

export interface PublicBinding {
  id: string;
  userId: string;
  desktopDeviceId: string;
  mobileDeviceId: string;
  capabilities: string[];
  createdAt: string;
  revokedAt: string | null;
}

export function toPublicBinding(row: DeviceBindingRow): PublicBinding {
  return {
    id: row.id,
    userId: row.user_id,
    desktopDeviceId: row.desktop_device_id,
    mobileDeviceId: row.mobile_device_id,
    capabilities: row.capabilities ?? [],
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export async function createPairingSession(
  admin: AdminClient,
  input: {
    userId: string;
    desktopDeviceId: string;
    deviceSecret: string;
  },
): Promise<{
  pairingId: string;
  code: string;
  bootstrapToken: string;
  expiresAt: string;
  qrPayload: string;
}> {
  await requireOwnedDevice(admin, {
    userId: input.userId,
    deviceId: input.desktopDeviceId,
    kind: "desktop",
    deviceSecret: input.deviceSecret,
  });

  const code = createPairingCode();
  const bootstrapToken = createRandomToken(48);
  const expiresAt = new Date(Date.now() + PAIRING_TTL_SECONDS * 1000).toISOString();

  const { data, error } = await admin
    .from("pairing_sessions")
    .insert({
      user_id: input.userId,
      desktop_device_id: input.desktopDeviceId,
      code_hash: await sha256Hex(code),
      bootstrap_token_hash: await sha256Hex(bootstrapToken),
      expires_at: expiresAt,
    })
    .select("id, expires_at")
    .single();

  if (error || !data) {
    console.error("pairing_sessions insert failed", error);
    throw new HttpError(500, "Failed to create pairing session.", "pairing_create_failed");
  }

  return {
    pairingId: data.id as string,
    code,
    bootstrapToken,
    expiresAt: data.expires_at as string,
    qrPayload: `mori://pair?code=${encodeURIComponent(code)}`,
  };
}

export async function joinPairingSession(
  admin: AdminClient,
  input: {
    userId: string;
    mobileDeviceId: string;
    deviceSecret: string;
    code: string;
    bootstrapToken: string;
    deviceName?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{
  device: PublicDevice;
  binding: PublicBinding;
  desktopDeviceId: string;
  pairingId: string;
}> {
  const mobile = await requireOwnedDevice(admin, {
    userId: input.userId,
    deviceId: input.mobileDeviceId,
    kind: "mobile",
    deviceSecret: input.deviceSecret,
  });

  const normalizedCode = normalizePairingCode(input.code);
  const token = input.bootstrapToken.trim();
  if (!normalizedCode || !token) {
    throw new HttpError(400, "Pairing code and bootstrapToken are required.", "invalid_request");
  }

  const codeHash = await sha256Hex(normalizedCode);
  const bootstrapTokenHash = await sha256Hex(token);
  const nowIso = new Date().toISOString();

  // Atomic claim: only one join wins when claimed_at is still null and not expired.
  const { data: claimed, error: claimError } = await admin
    .from("pairing_sessions")
    .update({ claimed_at: nowIso })
    .eq("code_hash", codeHash)
    .eq("bootstrap_token_hash", bootstrapTokenHash)
    .eq("user_id", input.userId)
    .is("claimed_at", null)
    .gt("expires_at", nowIso)
    .select(
      "id, user_id, desktop_device_id, code_hash, bootstrap_token_hash, expires_at, claimed_at, created_at",
    )
    .maybeSingle();

  if (claimError) {
    console.error("pairing claim failed", claimError);
    throw new HttpError(500, "Failed to claim pairing session.", "pairing_claim_failed");
  }

  const session = claimed as PairingSessionRow | null;
  if (!session) {
    throw new HttpError(400, "Pairing code is invalid or expired.", "pairing_invalid");
  }

  const unclaim = async () => {
    const { error } = await admin
      .from("pairing_sessions")
      .update({ claimed_at: null })
      .eq("id", session.id)
      .eq("claimed_at", nowIso);
    if (error) {
      console.error("pairing unclaim failed", error);
    }
  };

  const { data: desktopData, error: desktopError } = await admin
    .from("devices")
    .select(
      "id, user_id, kind, name, secret_hash, metadata, created_at, last_seen_at, disabled_at, vault_synced_at",
    )
    .eq("id", session.desktop_device_id)
    .maybeSingle();

  if (desktopError) {
    console.error("desktop lookup failed", desktopError);
    await unclaim();
    throw new HttpError(500, "Failed to load desktop device.", "device_lookup_failed");
  }

  const desktop = desktopData as DeviceRow | null;
  if (!desktop || desktop.user_id !== input.userId || desktop.kind !== "desktop" || desktop.disabled_at) {
    await unclaim();
    throw new HttpError(403, "Desktop device is not active.", "device_inactive");
  }

  let deviceRow = mobile;
  if (input.deviceName || input.metadata) {
    const patch: Record<string, unknown> = {};
    if (input.deviceName?.trim()) {
      patch.name = input.deviceName.trim();
    }
    if (input.metadata) {
      patch.metadata = { ...mobile.metadata, ...input.metadata };
    }
    const { data: updated, error: updateError } = await admin
      .from("devices")
      .update(patch)
      .eq("id", mobile.id)
      .eq("user_id", input.userId)
      .select(
        "id, user_id, kind, name, secret_hash, metadata, created_at, last_seen_at, disabled_at, vault_synced_at",
      )
      .single();
    if (updateError || !updated) {
      console.error("mobile profile update failed", updateError);
      await unclaim();
      throw new HttpError(500, "Failed to update mobile device.", "device_update_failed");
    }
    deviceRow = updated as DeviceRow;
  }

  const { data: existingBinding, error: existingBindingError } = await admin
    .from("device_bindings")
    .select("id, user_id, desktop_device_id, mobile_device_id, capabilities, created_at, revoked_at")
    .eq("desktop_device_id", desktop.id)
    .eq("mobile_device_id", deviceRow.id)
    .is("revoked_at", null)
    .maybeSingle();

  if (existingBindingError) {
    console.error("binding lookup failed", existingBindingError);
    await unclaim();
    throw new HttpError(500, "Failed to check existing binding.", "binding_lookup_failed");
  }
  if (existingBinding) {
    // Session stays claimed so the code cannot be reused.
    return {
      device: toPublicDevice(deviceRow),
      binding: toPublicBinding(existingBinding as DeviceBindingRow),
      desktopDeviceId: desktop.id,
      pairingId: session.id,
    };
  }

  const { data: bindingData, error: bindingError } = await admin
    .from("device_bindings")
    .insert({
      user_id: input.userId,
      desktop_device_id: desktop.id,
      mobile_device_id: deviceRow.id,
      capabilities: [...DEFAULT_BINDING_CAPABILITIES],
    })
    .select("id, user_id, desktop_device_id, mobile_device_id, capabilities, created_at, revoked_at")
    .single();

  if (bindingError || !bindingData) {
    if (bindingError?.code === "23505") {
      const { data: raced } = await admin
        .from("device_bindings")
        .select("id, user_id, desktop_device_id, mobile_device_id, capabilities, created_at, revoked_at")
        .eq("desktop_device_id", desktop.id)
        .eq("mobile_device_id", deviceRow.id)
        .maybeSingle();
      if (raced) {
        return {
          device: toPublicDevice(deviceRow),
          binding: toPublicBinding(raced as DeviceBindingRow),
          desktopDeviceId: desktop.id,
          pairingId: session.id,
        };
      }
    }
    console.error("device_bindings insert failed", bindingError);
    await unclaim();
    throw new HttpError(500, "Failed to create device binding.", "binding_failed");
  }

  return {
    device: toPublicDevice(deviceRow),
    binding: toPublicBinding(bindingData as DeviceBindingRow),
    desktopDeviceId: desktop.id,
    pairingId: session.id,
  };
}
