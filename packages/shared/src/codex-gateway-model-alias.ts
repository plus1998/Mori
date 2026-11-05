export type CodexGatewayApiCompat = "anthropic" | "openai_responses" | "openai_chat_completions";

export interface ParsedCodexGatewayModelAlias {
  providerId: string;
  upstreamModelId: string;
  /** Present only for the versioned route alias. Legacy aliases use the provider default. */
  apiCompat?: CodexGatewayApiCompat;
}

export const CODEX_GATEWAY_MODEL_ALIAS_SEPARATOR = "__";
export const CODEX_GATEWAY_ROUTE_ALIAS_V1_PREFIX = "eco_route_v1.";

const CODEX_GATEWAY_ROUTE_ALIAS_V1_NAMESPACE = "eco_route_v1";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export class InvalidCodexGatewayModelAliasError extends Error {
  constructor(alias: string, reason: string) {
    super(`Invalid Codex gateway model alias '${alias}': ${reason}`);
    this.name = "InvalidCodexGatewayModelAliasError";
  }
}

/**
 * Builds the legacy byte-compatible alias unless an explicit route API override is supplied.
 * The V1 form base64url-encodes both opaque ids so dots, separators, slashes, and Unicode round-trip.
 */
export function buildCodexGatewayModelAlias(
  providerId: string,
  upstreamModelId: string,
  apiCompat?: CodexGatewayApiCompat,
  candidateModelId?: string,
): string {
  if (candidateModelId?.trim()) return candidateModelId.trim();
  const provider = requireAliasPart(providerId, "Provider id");
  const model = requireAliasPart(upstreamModelId, "Upstream model id");
  if (!apiCompat) {
    return `eco_${provider}${CODEX_GATEWAY_MODEL_ALIAS_SEPARATOR}${model}`;
  }
  const wireCode = apiCompatToWireCode(apiCompat);
  return [
    CODEX_GATEWAY_ROUTE_ALIAS_V1_NAMESPACE,
    encodeBase64Url(provider),
    wireCode,
    encodeBase64Url(model),
  ].join(".");
}

/**
 * Parses both legacy aliases and the strict V1 route alias.
 * Anything in the reserved V1 namespace is rejected when malformed rather than treated as a model id.
 */
export function parseCodexGatewayModelAlias(
  requestedModel: string,
): ParsedCodexGatewayModelAlias | undefined {
  const trimmed = requestedModel.trim();
  if (
    trimmed === CODEX_GATEWAY_ROUTE_ALIAS_V1_NAMESPACE ||
    trimmed.startsWith(CODEX_GATEWAY_ROUTE_ALIAS_V1_PREFIX)
  ) {
    return parseVersionedAlias(trimmed);
  }

  const separatorIndex = trimmed.indexOf(CODEX_GATEWAY_MODEL_ALIAS_SEPARATOR);
  if (separatorIndex <= "eco_".length) {
    return undefined;
  }
  const slug = trimmed.slice(0, separatorIndex);
  if (!slug.startsWith("eco_")) {
    return undefined;
  }
  const providerId = slug.slice("eco_".length).trim();
  const upstreamModelId = trimmed.slice(separatorIndex + CODEX_GATEWAY_MODEL_ALIAS_SEPARATOR.length).trim();
  if (!providerId || !upstreamModelId) {
    return undefined;
  }
  return { providerId, upstreamModelId };
}

function parseVersionedAlias(alias: string): ParsedCodexGatewayModelAlias {
  const parts = alias.split(".");
  if (parts.length !== 4 || parts[0] !== CODEX_GATEWAY_ROUTE_ALIAS_V1_NAMESPACE) {
    throw new InvalidCodexGatewayModelAliasError(alias, "expected four V1 segments");
  }
  const encodedProviderId = parts[1];
  const wireCode = parts[2];
  const encodedModelId = parts[3];
  if (!encodedProviderId || !wireCode || !encodedModelId) {
    throw new InvalidCodexGatewayModelAliasError(alias, "V1 segments must be non-empty");
  }
  const apiCompat = wireCodeToApiCompat(wireCode);
  if (!apiCompat) {
    throw new InvalidCodexGatewayModelAliasError(alias, `unknown API compatibility code '${wireCode}'`);
  }

  const providerId = decodeBase64Url(encodedProviderId, alias, "provider id");
  const upstreamModelId = decodeBase64Url(encodedModelId, alias, "model id");
  if (!providerId || providerId !== providerId.trim()) {
    throw new InvalidCodexGatewayModelAliasError(alias, "provider id must be non-empty and trimmed");
  }
  if (!upstreamModelId || upstreamModelId !== upstreamModelId.trim()) {
    throw new InvalidCodexGatewayModelAliasError(alias, "model id must be non-empty and trimmed");
  }
  return { providerId, upstreamModelId, apiCompat };
}

function apiCompatToWireCode(apiCompat: CodexGatewayApiCompat): string {
  switch (apiCompat) {
    case "anthropic":
      return "a";
    case "openai_responses":
      return "r";
    case "openai_chat_completions":
      return "c";
    default:
      throw new Error(`Unsupported Codex gateway apiCompat: ${String(apiCompat)}`);
  }
}

function wireCodeToApiCompat(wireCode: string): CodexGatewayApiCompat | undefined {
  switch (wireCode) {
    case "a":
      return "anthropic";
    case "r":
      return "openai_responses";
    case "c":
      return "openai_chat_completions";
    default:
      return undefined;
  }
}

function requireAliasPart(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required for Codex gateway model alias`);
  }
  return trimmed;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL_ALPHABET[first >> 2];
    encoded += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    }
    if (third !== undefined) {
      encoded += BASE64URL_ALPHABET[third & 0x3f];
    }
  }
  return encoded;
}

function decodeBase64Url(encoded: string, alias: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new InvalidCodexGatewayModelAliasError(alias, `${label} is not canonical base64url`);
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bitCount = 0;
  for (const character of encoded) {
    const value = BASE64URL_ALPHABET.indexOf(character);
    if (value < 0) {
      throw new InvalidCodexGatewayModelAliasError(alias, `${label} is not canonical base64url`);
    }
    buffer = (buffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((buffer >> bitCount) & 0xff);
      buffer &= (1 << bitCount) - 1;
    }
  }
  if (buffer !== 0) {
    throw new InvalidCodexGatewayModelAliasError(alias, `${label} has non-zero padding bits`);
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new InvalidCodexGatewayModelAliasError(alias, `${label} is not valid UTF-8`);
  }
  if (encodeBase64Url(decoded) !== encoded) {
    throw new InvalidCodexGatewayModelAliasError(alias, `${label} is not canonical base64url`);
  }
  return decoded;
}

/** Candidate identities are opaque database keys; never decode them into routing data. */
export function isCandidateModelId(value: string | undefined): boolean {
  return Boolean(value?.trim().startsWith("cand-"));
}
