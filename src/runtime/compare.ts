/** Treat `undefined`, `null` and `''` as the same "unset" value. */
export function normalizeEmpty(v: unknown): unknown {
  return v === undefined || v === '' ? null : v;
}

/**
 * True when `expected` matches `actual`. Objects match when every key declared in
 * `expected` matches (extra live keys are ignored). Arrays must match element-wise.
 */
export function matchesSubset(expected: unknown, actual: unknown): boolean {
  const e = normalizeEmpty(expected);
  const a = normalizeEmpty(actual);
  if (e === null || a === null) return e === a;
  if (Array.isArray(e)) {
    return Array.isArray(a) && a.length === e.length && e.every((v, i) => matchesSubset(v, a[i]));
  }
  if (typeof e === 'object') {
    if (typeof a !== 'object' || Array.isArray(a)) return false;
    return Object.entries(e as Record<string, unknown>).every(([k, v]) =>
      matchesSubset(v, (a as Record<string, unknown>)[k]),
    );
  }
  return e === a;
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

export function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const sb = new Set(b);
  return a.some((x) => sb.has(x));
}
