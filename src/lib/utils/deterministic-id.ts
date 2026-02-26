/**
 * Deterministic ID helpers.
 *
 * We use FNV-1a for fast, stable, synchronous IDs when async SHA-256 hashing
 * is not practical in hot paths.
 */

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function deterministicId(
  prefix: string,
  ...parts: Array<string | number | boolean | null | undefined>
): string {
  const normalized = parts.map((part) => String(part ?? '')).join('|');
  const a = fnv1a32(normalized);
  const b = fnv1a32(`${normalized}|${parts.length}|${prefix}`);
  return `${prefix}-${a}${b}`;
}
