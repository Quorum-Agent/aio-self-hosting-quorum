/**
 * Platform-agnostic UUID generation.
 *
 * Uses `crypto.randomUUID()` which is available in:
 * - Node.js 14.17+ (global crypto)
 * - Modern browsers
 * - Deno
 *
 * This avoids importing `node:crypto` which breaks browser bundlers.
 */
export function randomUUID(): string {
  return crypto.randomUUID();
}
