// Runs the authentication smoke sequence through createHandler on Bun or Deno.
//   bun smoke/run.ts
//   deno run --unstable-sloppy-imports smoke/run.ts
import { createAuthApp } from '../fixtures/authentication.js'
import { runSmoke, SMOKE_API_KEY, SMOKE_USER } from './sequence.mjs'

const ctx = await createAuthApp({ config: { apiKey: { header: 'x-api-key', keys: [SMOKE_API_KEY] } } as any })

await ctx.app.service('users').create(SMOKE_USER)

const runtime = (globalThis as any).Bun ? 'bun' : (globalThis as any).Deno ? 'deno' : 'node'

console.log(
  `auth smoke ${await runSmoke(
    (path: string, init?: RequestInit) =>
      ctx.handler(new Request(`http://localhost${path}`, init)) as Promise<Response>
  )} on ${runtime}`
)
