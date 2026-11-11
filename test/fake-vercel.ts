import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  LiveDeployment,
  LiveDomainConfig,
  LiveEnvVar,
  LiveProject,
  LiveProjectDomain,
} from '../src/runtime/api-types';
import type { FetchLike } from '../src/runtime/client';
import { VercelClient } from '../src/runtime/client';
import type { Redactor } from '../src/runtime/redact';

export const TOKEN = 'vercel_tok_SUPERSECRET_0123456789';

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as T;
}

interface StoredEnv extends LiveEnvVar {
  plain: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: any;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/**
 * An in-memory stand-in for the parts of the Vercel REST API this library calls. Seeded
 * from recorded response fixtures; records every request so tests can assert on writes.
 */
export class FakeVercel {
  readonly projects = new Map<string, LiveProject>();
  readonly env = new Map<string, StoredEnv[]>();
  readonly domains = new Map<string, LiveProjectDomain[]>();
  readonly domainConfig = new Map<string, LiveDomainConfig>();
  deployments: LiveDeployment[] = [];
  readonly requests: RecordedRequest[] = [];
  /** Replies returned (in order) before normal routing, for error/retry tests. */
  readonly queued: Reply[] = [];
  /** Domains that come back unverified when attached. */
  readonly needsVerification = new Map<
    string,
    { type: string; domain: string; value: string; reason: string }[]
  >();
  private seq = 0;

  addProject(p: LiveProject, env: Omit<StoredEnv, 'id'>[] = [], domains: LiveProjectDomain[] = []): void {
    this.projects.set(p.id, structuredClone(p));
    this.env.set(
      p.id,
      env.map((e) => ({ ...structuredClone(e), id: this.id('env') })),
    );
    this.domains.set(p.id, structuredClone(domains));
  }

  get writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== 'GET');
  }

  client(opts: { teamId?: string; redactor?: Redactor } = {}): VercelClient {
    return new VercelClient({
      token: TOKEN,
      teamId: opts.teamId,
      fetch: this.fetch,
      redactor: opts.redactor,
      sleep: async () => {},
    });
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const query = Object.fromEntries(u.searchParams.entries());
    this.requests.push({ method: init.method, path: u.pathname, query, body });
    if (init.headers.Authorization !== `Bearer ${TOKEN}`)
      return respond({ status: 403, body: { error: { code: 'forbidden', message: 'Not authorized' } } });
    const reply = this.queued.shift() ?? this.route(init.method, decodeURIComponent(u.pathname), body);
    return respond(reply);
  };

  private id(prefix: string): string {
    return `${prefix}_${++this.seq}`;
  }

  private project(idOrName: string): LiveProject | undefined {
    return this.projects.get(idOrName) ?? [...this.projects.values()].find((p) => p.name === idOrName);
  }

  private route(method: string, path: string, body: any): Reply {
    const notFound: Reply = {
      status: 404,
      body: { error: { code: 'not_found', message: `Not found: ${path}` } },
    };
    let m: RegExpMatchArray | null;

    if (method === 'POST' && path === '/v11/projects') {
      if (this.project(body.name))
        return { status: 409, body: { error: { code: 'conflict', message: 'Project already exists' } } };
      const p: LiveProject = {
        id: this.id('prj'),
        name: body.name,
        accountId: 'team_test',
        framework: body.framework ?? null,
      };
      if (body.gitRepository) {
        const [org, repo] = body.gitRepository.repo.split('/');
        p.link = { type: body.gitRepository.type, org, repo, productionBranch: 'main' };
      }
      this.addProject(p);
      return { status: 200, body: p };
    }
    if ((m = path.match(/^\/v9\/projects\/([^/]+)$/))) {
      const p = this.project(m[1]!);
      if (!p) return notFound;
      if (method === 'GET') return { status: 200, body: p };
      if (method === 'PATCH') {
        for (const [k, v] of Object.entries(body)) {
          if (k === 'passwordProtection' && v) (p as any)[k] = { deploymentType: (v as any).deploymentType };
          else (p as any)[k] = v;
        }
        return { status: 200, body: p };
      }
    }
    if ((m = path.match(/^\/v9\/projects\/([^/]+)\/branch$/)) && method === 'PATCH') {
      const p = this.project(m[1]!);
      if (!p) return notFound;
      p.link = { ...(p.link ?? {}), productionBranch: body.branch };
      return { status: 200, body: p };
    }
    if ((m = path.match(/^\/v10\/projects\/([^/]+)\/env$/))) {
      const list = this.env.get(m[1]!);
      if (!list) return notFound;
      if (method === 'GET') return { status: 200, body: { envs: list.map(publicEnv) } };
      if (method === 'POST') {
        const clash = list.find(
          (e) =>
            e.key === body.key &&
            (e.gitBranch ?? null) === (body.gitBranch ?? null) &&
            (e.target as string[]).some((t) => body.target.includes(t)),
        );
        if (clash)
          return {
            status: 400,
            body: {
              error: { code: 'ENV_CONFLICT', message: `A variable with the name ${body.key} already exists` },
            },
          };
        const e: StoredEnv = {
          id: this.id('env'),
          key: body.key,
          type: body.type,
          target: body.target,
          gitBranch: body.gitBranch ?? null,
          comment: body.comment,
          plain: body.value,
        };
        list.push(e);
        return { status: 201, body: { created: publicEnv(e), failed: [] } };
      }
    }
    if ((m = path.match(/^\/v1\/projects\/([^/]+)\/env\/([^/]+)$/)) && method === 'GET') {
      const e = this.env.get(m[1]!)?.find((x) => x.id === m![2]);
      if (!e) return notFound;
      return {
        status: 200,
        body: {
          ...publicEnv(e),
          value: e.type === 'sensitive' ? undefined : e.plain,
          decrypted: e.type !== 'sensitive',
        },
      };
    }
    if ((m = path.match(/^\/v9\/projects\/([^/]+)\/env\/([^/]+)$/))) {
      const list = this.env.get(m[1]!);
      const i = list?.findIndex((x) => x.id === m![2]) ?? -1;
      if (!list || i < 0) return notFound;
      if (method === 'DELETE') {
        list.splice(i, 1);
        return { status: 200, body: {} };
      }
      if (method === 'PATCH') {
        const e = list[i]!;
        Object.assign(e, {
          type: body.type,
          target: body.target,
          gitBranch: body.gitBranch ?? null,
          comment: body.comment ?? e.comment,
          plain: body.value,
        });
        return { status: 200, body: publicEnv(e) };
      }
    }
    if ((m = path.match(/^\/v9\/projects\/([^/]+)\/domains$/)) && method === 'GET') {
      const list = this.domains.get(m[1]!);
      if (!list) return notFound;
      return {
        status: 200,
        body: { domains: list, pagination: { count: list.length, next: null, prev: null } },
      };
    }
    if ((m = path.match(/^\/v10\/projects\/([^/]+)\/domains$/)) && method === 'POST') {
      const list = this.domains.get(m[1]!);
      if (!list) return notFound;
      const verification = this.needsVerification.get(body.name);
      const d: LiveProjectDomain = {
        name: body.name,
        projectId: m[1],
        redirect: body.redirect ?? null,
        redirectStatusCode: body.redirectStatusCode ?? null,
        gitBranch: body.gitBranch ?? null,
        verified: !verification,
        ...(verification ? { verification } : {}),
      };
      list.push(d);
      return { status: 200, body: d };
    }
    if ((m = path.match(/^\/v9\/projects\/([^/]+)\/domains\/([^/]+)$/))) {
      const list = this.domains.get(m[1]!);
      const i = list?.findIndex((x) => x.name === m![2]) ?? -1;
      if (!list || i < 0) return notFound;
      if (method === 'DELETE') {
        list.splice(i, 1);
        return { status: 200, body: {} };
      }
      if (method === 'PATCH') {
        Object.assign(list[i]!, body);
        return { status: 200, body: list[i] };
      }
    }
    if ((m = path.match(/^\/v9\/projects\/([^/]+)\/domains\/([^/]+)\/verify$/)) && method === 'POST') {
      const d = this.domains.get(m[1]!)?.find((x) => x.name === m![2]);
      if (!d) return notFound;
      d.verified = true;
      return { status: 200, body: d };
    }
    if ((m = path.match(/^\/v6\/domains\/([^/]+)\/config$/)) && method === 'GET') {
      return {
        status: 200,
        body: this.domainConfig.get(m[1]!) ?? {
          misconfigured: true,
          recommendedCNAME: [],
          recommendedIPv4: [],
        },
      };
    }
    if ((m = path.match(/^\/v1\/projects\/([^/]+)\/protection-bypass$/)) && method === 'PATCH') {
      const p = this.project(m[1]!);
      if (!p) return notFound;
      const map = (p.protectionBypass ??= {});
      if (body.generate) {
        const secret = body.generate.secret ?? this.id('generated').padEnd(32, 'x');
        const isFirst = !Object.values(map).some((v) => v.scope === 'automation-bypass');
        map[secret] = {
          scope: 'automation-bypass',
          note: body.generate.note,
          createdAt: 1,
          isEnvVar: isFirst,
        };
      } else if (body.update) {
        for (const v of Object.values(map)) v.isEnvVar = false;
        map[body.update.secret]!.isEnvVar = body.update.isEnvVar;
      } else if (body.revoke) {
        delete map[body.revoke.secret];
      }
      return { status: 200, body: { protectionBypass: map } };
    }
    if (path === '/v7/deployments' && method === 'GET') {
      return { status: 200, body: { deployments: this.deployments, pagination: { next: null } } };
    }
    return notFound;
  }
}

function publicEnv(e: StoredEnv): LiveEnvVar {
  const { plain, ...rest } = e;
  if (e.type === 'plain') return { ...rest, value: plain };
  if (e.type === 'encrypted') return { ...rest, value: `enc:${Buffer.from(plain).toString('base64')}` };
  return { ...rest };
}

function respond(r: Reply) {
  const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const text = r.body === undefined ? '' : JSON.stringify(r.body);
  return Promise.resolve({
    status: r.status,
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    text: async () => text,
  });
}

/** A secret resolver over an in-memory map keyed by `secretId` (JSON strings allowed). */
export function memorySecrets(values: Record<string, string>) {
  return {
    calls: [] as string[],
    async resolve(ref: { secretId: string; jsonKey?: string }) {
      this.calls.push(ref.secretId);
      const raw = values[ref.secretId];
      if (raw === undefined) throw new Error(`no secret ${ref.secretId}`);
      return ref.jsonKey ? JSON.parse(raw)[ref.jsonKey] : raw;
    },
  };
}
