import { createHmac } from "node:crypto";
import type { I18nKey } from "../shared/i18n-catalogs";

/**
 * The imported secret cannot be decoded. `message` is a catalog key rather than display text: this
 * helper stays locale-free, and the caller renders the key in the user's language.
 */
export class TotpSecretError extends Error {
  constructor(readonly key: I18nKey) {
    super(key);
    this.name = "TotpSecretError";
  }
}

/** RFC 6238: imported Base32 secret, SHA-1, 30 seconds, six digits. */
export function generateAccountTotp(secret: string, now = Date.now(), digits = 6): { code: string; remainingSeconds: number } {
  const normalized = secret.replace(/[\s-]/gu, "").toUpperCase().replace(/=+$/u, "");
  if (!normalized || !/^[A-Z2-7]+$/u.test(normalized)) throw new TotpSecretError("assistant.error.invalidBase32");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
    }
  }
  if ([1, 3, 6].includes(normalized.length % 8) || bytes.length === 0 || (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0)) {
    throw new TotpSecretError("assistant.error.invalidLength");
  }
  const seconds = Math.floor(now / 1_000);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const hash = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hash[hash.length - 1]! & 15;
  const number = hash.readUInt32BE(offset) & 0x7fffffff;
  return { code: String(number % (10 ** digits)).padStart(digits, "0"), remainingSeconds: 30 - (seconds % 30) };
}

export function isAccountLoginPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** Fill only the requested visible field; never submit the form. */
export function accountLoginFillScript(field: "email" | "password" | "code", value: string): string {
  const selectors = {
    email: 'input[type="email"],input[autocomplete="username"],input[name="email"],input[name="username"]',
    password: 'input[type="password"],input[autocomplete="current-password"]',
    code: 'input[autocomplete="one-time-code"],input[name="code"],input[name="otp"],input[name="totp"],input[inputmode="numeric"]',
  };
  return `(() => {
    const value = ${JSON.stringify(value)};
    const fields = Array.from(document.querySelectorAll(${JSON.stringify(selectors[field])})).filter(
      input => !input.disabled && !input.readOnly && input.getClientRects().length > 0
    );
    if (!fields.length) return false;
    const setValue = (input, text) => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (${JSON.stringify(field)} === 'code' && fields.length === value.length && fields.every(input => input.maxLength === 1)) {
      fields.forEach((input, index) => setValue(input, value[index]));
    } else {
      setValue(fields[0], value);
    }
    return true;
  })()`;
}
