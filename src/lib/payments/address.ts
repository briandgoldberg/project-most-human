const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode base58, or null if the text isn't base58. */
function base58Decode(text: string): Uint8Array | null {
  const bytes: number[] = [];
  for (const ch of text) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/**
 * Whether `address` is shaped like a Solana address: base58 for exactly 32
 * bytes. Kept free of the Solana libraries so that validating a wallet never
 * loads them.
 */
export function isValidAddress(address: string): boolean {
  if (address.length < 32 || address.length > 44) return false;
  return base58Decode(address)?.length === 32;
}
