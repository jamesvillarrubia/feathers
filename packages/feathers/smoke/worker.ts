// Cloudflare Worker that serves the authentication fixture app through createHandler.
import { createAuthApp } from '../fixtures/authentication.js'
import { SMOKE_API_KEY, SMOKE_USER } from './sequence.mjs'

let ready: Promise<(request: Request) => Promise<Response>> | undefined

// Workers forbid random values in global scope, so the app (and its password hash) starts on the first request.
const init = async () => {
  const ctx = await createAuthApp({
    config: { apiKey: { header: 'x-api-key', keys: [SMOKE_API_KEY] } } as any
  })

  await ctx.app.service('users').create(SMOKE_USER)

  return ctx.handler as (request: Request) => Promise<Response>
}

export default {
  async fetch(request: Request) {
    ready ??= init()

    return (await ready)(request)
  }
}
