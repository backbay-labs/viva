// Shared web modules fall back to btoa/atob for base64; Hermes availability
// varies by release, so install pure-JS versions only when missing.
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(binary: string): string {
  let output = "";
  for (let index = 0; index < binary.length; index += 3) {
    const a = binary.charCodeAt(index);
    const b = index + 1 < binary.length ? binary.charCodeAt(index + 1) : Number.NaN;
    const c = index + 2 < binary.length ? binary.charCodeAt(index + 2) : Number.NaN;
    output += BASE64_ALPHABET[a >> 2];
    output += BASE64_ALPHABET[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    output += Number.isNaN(b)
      ? "="
      : BASE64_ALPHABET[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    output += Number.isNaN(c) ? "=" : BASE64_ALPHABET[c & 63];
  }
  return output;
}

function decodeBase64(base64: string): string {
  const clean = base64.replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  let output = "";
  for (const char of clean) {
    const digit = BASE64_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("Invalid base64 character");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return output;
}

export function installRuntimeGlobals(): void {
  const globals = globalThis as {
    atob?: (data: string) => string;
    btoa?: (data: string) => string;
  };
  if (typeof globals.btoa !== "function") globals.btoa = encodeBase64;
  if (typeof globals.atob !== "function") globals.atob = decodeBase64;
}
