import { createHash } from 'crypto';

/**
 * Generates a deterministic alphanumeric ID with a given prefix.
 * Useful for ensuring idempotency and preventing duplicate rows in PostgreSQL text PK columns.
 */
export function generateDeterministicId(prefix: string, parts: any[]): string {
  const input = parts.map(p => {
    if (p instanceof Date) {
      return p.toISOString();
    }
    return String(p);
  }).join(':');
  
  const hash = createHash('md5').update(input).digest('hex');
  return `${prefix}_${hash}`;
}
