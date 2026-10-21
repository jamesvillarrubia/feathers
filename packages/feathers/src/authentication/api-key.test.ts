import { describe, it, expect } from 'vitest'
import { createAuthApp } from '../../fixtures/authentication.js'
import { AuthenticationService, matchApiKey } from './index.js'

const KEYS = ['key-one-abcdef', 'key-two-ghijkl']

const withKeys = () => createAuthApp({ config: { apiKey: { header: 'x-api-key', keys: KEYS } } as any })

describe('api-key strategy', () => {
  // 22
  it('returns 200 on /reports with a listed key', async () => {
    const ctx = await withKeys()
    const res = await ctx.call('/reports', { headers: { 'x-api-key': KEYS[1] } })

    expect(res.status).toBe(200)
  })

  // 22
  it('returns 401 Invalid login for a wrong key and for a missing header', async () => {
    const ctx = await withKeys()
    const wrong = await ctx.call('/reports', { headers: { 'x-api-key': 'nope' } })
    const missing = await ctx.call('/reports')

    expect(wrong.status).toBe(401)
    expect((await wrong.json()).message).toBe('Invalid login')
    expect(missing.status).toBe(401)
    expect((await missing.json()).message).toBe('Invalid login')
  })

  it('reads a custom header name', async () => {
    const ctx = await createAuthApp({ config: { apiKey: { header: 'x-token', keys: KEYS } } as any })

    expect((await ctx.call('/reports', { headers: { 'x-token': KEYS[0] } })).status).toBe(200)
    expect((await ctx.call('/reports', { headers: { 'x-api-key': KEYS[0] } })).status).toBe(401)
  })

  it('sets params.apiKey to {} and loads no user for a keys match', async () => {
    const ctx = await withKeys()

    await ctx.call('/reports', { headers: { 'x-api-key': KEYS[0] } })

    expect(ctx.reports.seen.params.authenticated).toBe(true)
    expect(ctx.reports.seen.params.apiKey).toEqual({})
    expect(ctx.reports.seen.params.user).toBeUndefined()
  })

  // 23
  it('with verify: null gets 401 and an object gets 200 with params.apiKey set', async () => {
    const ctx = await createAuthApp({
      config: {
        apiKey: {
          header: 'x-api-key',
          verify: async (key: string) => (key === 'good' ? { client: 'a' } : null)
        }
      } as any
    })

    expect((await ctx.call('/reports', { headers: { 'x-api-key': 'bad' } })).status).toBe(401)
    expect((await ctx.call('/reports', { headers: { 'x-api-key': 'good' } })).status).toBe(200)
    expect(ctx.reports.seen.params.apiKey.client).toBe('a')
  })

  // S7
  it.each([
    ['undefined', [undefined]],
    ['an empty string', ['']],
    ['a number', [42]],
    ['one bad entry among good ones', ['good-key-aaaaaaaaaaaa', undefined]]
  ])('setup() throws when apiKey.keys holds %s', async (_name, keys) => {
    await expect(createAuthApp({ config: { apiKey: { header: 'x-api-key', keys } } as any })).rejects.toThrow(
      /non-empty string/
    )
  })

  // 24
  it('POST /authentication with strategy api-key returns 401 and mints no token', async () => {
    const ctx = await withKeys()
    const res = await ctx.login({ strategy: 'api-key', apiKey: KEYS[0] })
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.accessToken).toBeUndefined()
  })

  // 24
  it('setup() throws when authStrategies contains api-key', async () => {
    await expect(
      createAuthApp({
        config: {
          authStrategies: ['jwt', 'local', 'api-key'],
          apiKey: { header: 'x-api-key', keys: KEYS }
        } as any
      })
    ).rejects.toThrow(/api-key/)
  })

  // 24
  it('setup() throws when apiKey sets both keys and verify, or neither', async () => {
    await expect(
      createAuthApp({
        config: { apiKey: { header: 'x-api-key', keys: KEYS, verify: async () => ({}) } } as any
      })
    ).rejects.toThrow(/exactly one/)
    await expect(createAuthApp({ config: { apiKey: { header: 'x-api-key' } } as any })).rejects.toThrow(
      /exactly one/
    )
  })

  it('does not echo the key in the 401 body', async () => {
    const ctx = await withKeys()
    const res = await ctx.call('/reports', { headers: { 'x-api-key': 'secret-value-xyz' } })

    expect(JSON.stringify(await res.json())).not.toContain('secret-value-xyz')
  })

  it('exports no api-key strategy when apiKey is not configured', async () => {
    const service = new AuthenticationService({
      secret: 'x'.repeat(32),
      service: 'users',
      authStrategies: ['jwt']
    })

    expect(service.getStrategy('api-key')).toBeUndefined()
  })
})

describe('matchApiKey', () => {
  // 25
  it('visits the same number of bytes for any submitted key length and match position', async () => {
    const counts: number[] = []

    for (const submitted of ['k', 'key-one-abcdef', 'key-two-ghijkl', 'x'.repeat(500), '']) {
      const visits = { count: 0 }

      await matchApiKey(submitted, KEYS, visits)
      counts.push(visits.count)
    }

    // 2 keys * 32 SHA-256 digest bytes, whatever the input
    expect(new Set(counts)).toEqual(new Set([64]))
  })

  it('matches a listed key and rejects others', async () => {
    expect(await matchApiKey(KEYS[1], KEYS)).toBe(true)
    expect(await matchApiKey('other', KEYS)).toBe(false)
    expect(await matchApiKey('', [])).toBe(false)
  })
})

describe('sse tickets in tier 1', () => {
  // 21
  it('GET /sse with ?ticket=abc and no Authorization header returns 401', async () => {
    const ctx = await createAuthApp()
    const res = await ctx.call('/sse?ticket=abc')

    expect(res.status).toBe(401)
  })

  // 21
  it("POST /authentication with strategy 'sse-ticket' returns 401", async () => {
    const ctx = await createAuthApp()
    const res = await ctx.login({ strategy: 'sse-ticket' })

    expect(res.status).toBe(401)
  })
})
