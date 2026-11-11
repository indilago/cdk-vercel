# Contributing

```sh
pnpm install
pnpm test        # vitest; bundles the handler first
pnpm typecheck
pnpm lint        # biome
pnpm build       # dist/ + assets/handler
```

- Tests never call the real Vercel API. `test/fake-vercel.ts` is an in-memory fake seeded from
  response fixtures in `test/fixtures/`. When you add an endpoint, add a fixture shaped like a real
  response (scrub IDs and secrets) and route it in the fake.
- Check request shapes against Vercel's OpenAPI spec (`https://openapi.vercel.sh/`).
- Anything that writes to Vercel must respect partial management: never send a field the user
  didn't declare.
- Never log or put secret values (token, resolved secrets, decrypted env values, bypass secrets)
  in errors. Add values to the `Redactor` as soon as they are known.

## Releasing

Releases publish to npm from GitHub Actions with
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no npm token), and npm
attaches provenance automatically.

1. On a branch, bump `version` in `package.json` and add a `CHANGELOG.md` entry. Open a PR and merge it.
2. Tag the merge commit on `main` and push the tag:

   ```sh
   git tag -a v0.1.2 -m v0.1.2 && git push origin v0.1.2
   ```

`.github/workflows/release.yml` checks that the tag matches `package.json`, runs lint, typecheck,
tests and build, then runs `npm publish`. If the version is already on npm it skips publishing.
