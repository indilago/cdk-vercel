import { Redactor } from './redact';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface VercelClientOptions {
  readonly token: string;
  /** Sent as `?teamId=` on every request. */
  readonly teamId?: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly redactor?: Redactor;
  /** Retries for 429s (every method) and 5xx/network errors (GET/PATCH/DELETE only). @default 5 */
  readonly maxRetries?: number;
  /** Cap on a single wait between retries (Vercel's rate-limit windows can be a minute). @default 60000 */
  readonly maxRetryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
}

/** A failed Vercel API call. The message carries the HTTP status and Vercel's (redacted) error body. */
export class VercelApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Vercel API ${method} ${path} failed: HTTP ${status}: ${body || '(empty body)'}`);
    this.name = 'VercelApiError';
  }

  /** Vercel's `error.code`, when the body has one. */
  get code(): string | undefined {
    try {
      return JSON.parse(this.body)?.error?.code;
    } catch {
      return undefined;
    }
  }
}

const RETRY_SAFE_METHODS = new Set(['GET', 'PATCH', 'DELETE', 'PUT']);

/** A small, dependency-free client for the Vercel REST API. */
export class VercelClient {
  readonly teamId?: string;
  readonly redactor: Redactor;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: VercelClientOptions) {
    this.token = opts.token;
    this.teamId = opts.teamId;
    this.baseUrl = (opts.baseUrl ?? 'https://api.vercel.com').replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.redactor = opts.redactor ?? new Redactor();
    this.redactor.add(opts.token);
    this.maxRetries = opts.maxRetries ?? 5;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 60_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.url(path, opts.query);
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchFn(url, { method, headers, body });
      } catch (err) {
        if (attempt < this.maxRetries && RETRY_SAFE_METHODS.has(method)) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new Error(this.redactor.redact(`Vercel API ${method} ${path} failed: ${String(err)}`));
      }

      const text = await res.text();
      if (res.status >= 200 && res.status < 300) {
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const retryable = res.status === 429 || (res.status >= 500 && RETRY_SAFE_METHODS.has(method));
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(
          res.status === 429 ? this.rateLimitDelay(res.headers, attempt) : this.backoff(attempt),
        );
        continue;
      }
      throw new VercelApiError(method, path, res.status, this.redactor.redact(text));
    }
  }

  get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  /** GET that returns `undefined` on 404 instead of throwing. */
  async getOrUndefined<T = unknown>(
    path: string,
    query?: Record<string, QueryValue>,
  ): Promise<T | undefined> {
    try {
      return await this.get<T>(path, query);
    } catch (err) {
      if (err instanceof VercelApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  private url(path: string, query: Record<string, QueryValue> = {}): string {
    const params = new URLSearchParams();
    if (this.teamId) params.set('teamId', this.teamId);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  private backoff(attempt: number): number {
    return Math.min(this.maxRetryDelayMs, 500 * 2 ** attempt);
  }

  private rateLimitDelay(headers: { get(name: string): string | null }, attempt: number): number {
    const retryAfter = headers.get('retry-after');
    if (retryAfter && /^\d+$/.test(retryAfter)) {
      return Math.min(this.maxRetryDelayMs, Number(retryAfter) * 1000);
    }
    const reset = headers.get('x-ratelimit-reset');
    if (reset && /^\d+$/.test(reset)) {
      const ms = Number(reset) * 1000 - Date.now();
      if (ms > 0) return Math.min(this.maxRetryDelayMs, ms);
    }
    return this.backoff(attempt);
  }
}

/** Walk a Vercel paginated list endpoint (`pagination.next` → `until`). */
export async function listAll<T>(
  client: VercelClient,
  path: string,
  itemsKey: string,
  query: Record<string, QueryValue> = {},
): Promise<T[]> {
  const out: T[] = [];
  let until: number | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await client.get<Record<string, unknown>>(path, { ...query, until });
    const items = (res?.[itemsKey] as T[] | undefined) ?? [];
    out.push(...items);
    const next = (res?.pagination as { next?: number | null } | undefined)?.next;
    if (!next || items.length === 0) return out;
    until = next;
  }
  return out;
}
