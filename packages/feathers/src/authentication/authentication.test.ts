import { describe, it, expect, vi } from 'vitest'
import { createAuthApp, SECRET } from '../../fixtures/authentication.js'
import { createPbkdf2Hasher, pbkdf2Hasher, type PasswordHasher } from './index.js'
import { signJwt, base64urlEncode, decodeJwtPayload } from './jwt.js'

const now = () => Math.floor(Date.now() / 1000)

// Stand-in for an app-supplied hasher that verifies legacy `$2b$` hashes. The real
// thing would call a bcrypt library inside the app; core ships none.
const legacyHash = async (password: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password))

  return `$2b$10$${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}
const legacyHasher = (iterations: number): PasswordHasher => {
  const pbkdf2 = createPbkdf2Hasher(iterations)

  return {
    hash: (password) => pbkdf2.hash(password),
    async verify(password, hash) {
      return hash.startsWith('$2') ? (await legacyHash(password)) === hash : pbkdf2.verify(password, hash)
    },
    needsRehash: (hash) => hash.startsWith('$2') || pbkdf2.needsRehash(hash)
  }
}

async function setup(options: Parameters<typeof createAuthApp>[0] = {}) {
  const ctx = await createAuthApp(options)
  const user = await ctx.app.service('users').create({ email: 'a@example.com', password: 'secret' })

  return { ...ctx, user }
}

async function token(ctx: Awaited<ReturnType<typeof setup>>) {
  const res = await ctx.login({ strategy: 'local', email: 'a@example.com', password: 'secret' })

  return (await res.json()).accessToken as string
}

describe('local login', () => {
  // 1
  it('returns 201 with an accessToken and no password anywhere in the body', async () => {
    const ctx = await setup()
    const res = await ctx.login({ strategy: 'local', email: 'a@example.com', password: 'secret' })
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(typeof body.accessToken).toBe('string')
    expect(JSON.stringify(body)).not.toContain('password')
    expect(body.user.email).toBe('a@example.com')
  })

  // 2
  it('answers a wrong password and an unknown email with the same 401 Invalid login', async () => {
    const ctx = await setup()
    const wrong = await ctx.login({ strategy: 'local', email: 'a@example.com', password: 'nope' })
    const unknown = await ctx.login({ strategy: 'local', email: 'x@example.com', password: 'secret' })

    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect((await wrong.json()).message).toBe('Invalid login')
    expect((await unknown.json()).message).toBe('Invalid login')
  })

  // S2
  it.each([
    ['bad characters', 'pbkdf2-sha256$600000$!!$!!'],
    ['too few parts', 'pbkdf2-sha256$a$b'],
    ['bad base64 length', 'pbkdf2-sha256$600000$a$b'],
    ['short derived key', 'pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'],
    ['non numeric count', 'pbkdf2-sha256$abc$AAAAAAAAAAAAAAAAAAAAAA==$AAAA']
  ])('answers a malformed stored hash (%s) with 401 Invalid login, not 500', async (_name, stored) => {
    const ctx = await createAuthApp()

    ctx.users.seed({ email: 'bad@example.com', password: stored })

    const res = await ctx.login({ strategy: 'local', email: 'bad@example.com', password: 'secret' })

    expect(res.status).toBe(401)
    expect((await res.json()).message).toBe('Invalid login')
  })

  // S5
  it('builds the dummy hash at setup and verifies once for an unknown email', async () => {
    const real = createPbkdf2Hasher(100000)
    const calls = { hash: 0, verify: 0 }
    const spy: PasswordHasher = {
      hash: (password) => (calls.hash++, real.hash(password)),
      verify: (password, hash) => (calls.verify++, real.verify(password, hash)),
      needsRehash: (hash) => real.needsRehash(hash)
    }
    const ctx = await createAuthApp({ config: { local: { iterations: 100000, hasher: spy } } })

    expect(calls.hash).toBe(1)

    const res = await ctx.login({ strategy: 'local', email: 'nobody@example.com', password: 'secret' })

    expect(res.status).toBe(401)
    expect(calls.verify).toBe(1)
    expect(calls.hash).toBe(1)
  })

  // 19
  it('has no refreshToken and answers strategy refresh with 401', async () => {
    const ctx = await setup()
    const ok = await ctx.login({ strategy: 'local', email: 'a@example.com', password: 'secret' })
    const refresh = await ctx.login({ strategy: 'refresh' })

    expect(Object.keys(await ok.json())).not.toContain('refreshToken')
    expect(refresh.status).toBe(401)
  })
})

describe('absolute session expiry', () => {
  const LOGIN = { strategy: 'local', email: 'a@example.com', password: 'secret' }

  // 33
  it('stamps a local login token with auth_time and exp = auth_time + expiresIn', async () => {
    const ctx = await setup({ config: { jwt: { expiresIn: 600 } } })
    const body = await (await ctx.login(LOGIN)).json()
    const payload = decodeJwtPayload(body.accessToken)!

    expect(typeof payload.auth_time).toBe('number')
    expect(payload.exp).toBe((payload.auth_time as number) + 600)
  })

  // 34
  it('keeps the original exp and auth_time when strategy jwt re-mints later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    try {
      const ctx = await setup({ config: { jwt: { expiresIn: 600 } } })
      const firstToken = (await (await ctx.login(LOGIN)).json()).accessToken as string
      const first = decodeJwtPayload(firstToken)!

      vi.setSystemTime(Date.now() + 300_000)

      const res = await ctx.login({ strategy: 'jwt', accessToken: firstToken })
      const again = decodeJwtPayload((await res.json()).accessToken)!

      expect(res.status).toBe(201)
      expect(again.auth_time).toBe(first.auth_time)
      expect(again.exp).toBe(first.exp)
      expect(again.iat).toBeGreaterThan(first.iat as number)
    } finally {
      vi.useRealTimers()
    }
  })

  // 35
  it('rejects a token without auth_time at strategy jwt but accepts it on a protected route', async () => {
    const ctx = await setup()
    const legacy = await signJwt(
      { sub: String(ctx.user.id), iss: 'feathers', iat: now(), exp: now() + 600 },
      SECRET
    )
    const mint = await ctx.login({ strategy: 'jwt', accessToken: legacy })
    const route = await ctx.call('/messages', { headers: { authorization: `Bearer ${legacy}` } })

    expect(mint.status).toBe(401)
    expect(route.status).toBe(200)
  })
})

describe('authenticate hook on /messages', () => {
  // 3
  it('returns 401 without an Authorization header', async () => {
    const ctx = await setup()

    expect((await ctx.call('/messages')).status).toBe(401)
  })

  // 4
  it('returns 200 with a valid Bearer token', async () => {
    const ctx = await setup()
    const res = await ctx.call('/messages', { headers: { authorization: `Bearer ${await token(ctx)}` } })

    expect(res.status).toBe(200)
  })

  it('rejects a bare token without the Bearer scheme', async () => {
    const ctx = await setup()
    const res = await ctx.call('/messages', { headers: { authorization: await token(ctx) } })

    expect(res.status).toBe(401)
  })

  // 5
  it('returns 401 for an expired token', async () => {
    const ctx = await setup()
    const expired = await signJwt({ sub: String(ctx.user.id), iss: 'feathers', exp: now() - 10 }, SECRET)
    const res = await ctx.call('/messages', { headers: { authorization: `Bearer ${expired}` } })

    expect(res.status).toBe(401)
  })

  // 6
  it('returns 401 for a wrong-secret token and for alg none', async () => {
    const ctx = await setup()
    const payload = { sub: String(ctx.user.id), iss: 'feathers', exp: now() + 60 }
    const wrongSecret = await signJwt(payload, 'another-secret-that-is-at-least-32-bytes')
    const none = `${base64urlEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64urlEncode(JSON.stringify(payload))}.`

    for (const bad of [wrongSecret, none]) {
      const res = await ctx.call('/messages', { headers: { authorization: `Bearer ${bad}` } })

      expect(res.status).toBe(401)
    }
  })

  // 7
  it('lets an internal call without a provider through without a token', async () => {
    const ctx = await setup()

    await expect(ctx.app.service('messages').find()).resolves.toEqual([{ text: 'hello' }])
  })
})

describe('protect', () => {
  // 8
  it('GET /users returns records without a password key', async () => {
    const ctx = await setup()
    const res = await ctx.call('/users')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.length).toBe(1)
    expect(Object.keys(body[0])).not.toContain('password')
  })

  // S6
  it.each([
    ['a $like filter', '/users?password[$like]=pbkdf2-sha256$6%25'],
    ['a direct equality filter', '/users?password=x'],
    ['a $sort', '/users?$sort[password]=1'],
    ['a $select', '/users?$select[]=password'],
    ['a filter inside $or', '/users?$or[0][password]=x'],
    ['a filter inside $and', '/users?$and[0][password][$gt]=a'],
    ['a dotted path', '/users?password.x=1']
  ])('rejects %s on a protected field with 400', async (_name, path) => {
    const ctx = await setup()
    const res = await ctx.call(path)

    expect(res.status).toBe(400)
  })

  it('still answers filters, sorts and selects on other fields', async () => {
    const ctx = await setup()
    const res = await ctx.call('/users?email=a@example.com&$sort[email]=1&$select[]=email')

    expect(res.status).toBe(200)
  })

  it('does not restrict internal calls that query a protected field', async () => {
    const ctx = await setup()

    await expect(ctx.app.service('users').find({ query: { password: 'x' } })).resolves.toEqual([])
  })
})

describe('sse', () => {
  const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, text: string) => {
    let seen = ''

    while (!seen.includes(text)) {
      const { value, done } = await reader.read()

      if (done) break
      seen += new TextDecoder().decode(value)
    }

    return { seen, reader }
  }

  // 9
  it('opens a stream with a Bearer header, sets connection.user, and 401s without one', async () => {
    const ctx = await setup()
    let connectedUser: any

    ctx.app.on('connection', (connection: any) => {
      connectedUser = connection.user
      ctx.app.channel('authenticated').join(connection)
    })
    ctx.app.publish(() => ctx.app.channel('authenticated'))

    const unauth = await ctx.call('/sse')

    expect(unauth.status).toBe(401)

    const res = await ctx.call('/sse', { headers: { authorization: `Bearer ${await token(ctx)}` } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    const reader = res.body!.getReader()

    await readUntil(reader, 'connected')

    expect(connectedUser.email).toBe('a@example.com')

    await ctx.app.service('messages').create({ text: 'live' })

    const { seen } = await readUntil(reader, 'live')

    expect(seen).toContain('live')
    await reader.cancel()
  })

  // S4
  it('gives the connection no raw token and a user without the password field', async () => {
    const ctx = await setup()
    const accessToken = await token(ctx)
    let seen: any

    ctx.app.on('connection', (connection: any) => {
      seen = connection
    })

    const res = await ctx.call('/sse', { headers: { authorization: `Bearer ${accessToken}` } })
    const reader = res.body!.getReader()

    await readUntil(reader, 'connected')

    expect(JSON.stringify(seen)).not.toContain(accessToken)
    expect(seen.authentication.accessToken).toBeUndefined()
    expect(typeof seen.authentication.payload.exp).toBe('number')
    expect(seen.user.email).toBe('a@example.com')
    expect(Object.keys(seen.user)).not.toContain('password')
    await reader.cancel()
  })

  // 10
  it('ends the stream within 2 seconds of a token that expires in 1 second', async () => {
    const ctx = await setup()
    const short = await signJwt({ sub: String(ctx.user.id), iss: 'feathers', exp: now() + 1 }, SECRET)
    const started = Date.now()
    const res = await ctx.call('/sse', { headers: { authorization: `Bearer ${short}` } })
    const reader = res.body!.getReader()

    while (!(await reader.read()).done) {
      // drain until the server closes the stream
    }

    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('hashers and rehash', () => {
  // 16
  it('logs in a user with a $2b$ hash through an app-supplied hasher; wrong password is 401', async () => {
    const ctx = await createAuthApp({
      config: { local: { iterations: 100000, hasher: legacyHasher(100000) } }
    })

    ctx.users.seed({ email: 'old@example.com', password: await legacyHash('legacy-pw') })

    const ok = await ctx.login({ strategy: 'local', email: 'old@example.com', password: 'legacy-pw' })
    const bad = await ctx.login({ strategy: 'local', email: 'old@example.com', password: 'nope' })

    expect(ok.status).toBe(201)
    expect(typeof (await ok.json()).accessToken).toBe('string')
    expect(bad.status).toBe(401)
    expect((await bad.json()).message).toBe('Invalid login')
  })

  // 17
  it('also logs in a user whose stored hash is pbkdf2-sha256$ with the same hasher', async () => {
    const ctx = await createAuthApp({
      config: { local: { iterations: 100000, hasher: legacyHasher(100000) } }
    })

    ctx.users.seed({ email: 'new@example.com', password: await createPbkdf2Hasher(100000).hash('pw') })

    const res = await ctx.login({ strategy: 'local', email: 'new@example.com', password: 'pw' })

    expect(res.status).toBe(201)
  })

  // 27
  it('rewrites a $2b$ hash to pbkdf2-sha256$ on login and a second login works', async () => {
    const ctx = await createAuthApp({
      config: { local: { iterations: 100000, hasher: legacyHasher(100000) } }
    })
    const user = ctx.users.seed({ email: 'old@example.com', password: await legacyHash('legacy-pw') })
    const first = await ctx.login({ strategy: 'local', email: 'old@example.com', password: 'legacy-pw' })

    expect(first.status).toBe(201)
    expect(ctx.users.records.find((r) => r.id === user.id)!.password.startsWith('pbkdf2-sha256$')).toBe(true)

    const second = await ctx.login({ strategy: 'local', email: 'old@example.com', password: 'legacy-pw' })

    expect(second.status).toBe(201)
  })

  // 28
  it('rewrites a pbkdf2 hash with the new iteration count; no patch when the count is current', async () => {
    const ctx = await createAuthApp({ config: { local: { iterations: 200000 } } })
    const user = ctx.users.seed({
      email: 'a@example.com',
      password: await createPbkdf2Hasher(100000).hash('pw')
    })
    const res = await ctx.login({ strategy: 'local', email: 'a@example.com', password: 'pw' })

    expect(res.status).toBe(201)
    expect(ctx.users.patchCalls.length).toBe(1)
    expect(ctx.users.records.find((r) => r.id === user.id)!.password.split('$')[1]).toBe('200000')

    ctx.users.patchCalls.length = 0

    const again = await ctx.login({ strategy: 'local', email: 'a@example.com', password: 'pw' })

    expect(again.status).toBe(201)
    expect(ctx.users.patchCalls.length).toBe(0)
  })

  // 29
  it('still returns 201 when the rehash patch rejects and logs only the user id', async () => {
    const ctx = await createAuthApp({ config: { local: { iterations: 200000 } } })
    const oldHash = await createPbkdf2Hasher(100000).hash('pw')
    const user = ctx.users.seed({ email: 'a@example.com', password: oldHash })

    ctx.users.failPatch = true

    const res = await ctx.login({ strategy: 'local', email: 'a@example.com', password: 'pw' })

    expect(res.status).toBe(201)
    expect(typeof (await res.json()).accessToken).toBe('string')
    expect(ctx.logs.length).toBe(1)
    expect(ctx.logs[0]).toContain(String(user.id))
    expect(ctx.logs[0]).not.toContain('pw')
    expect(ctx.logs[0]).not.toContain(oldHash)
    expect(ctx.logs[0]).not.toContain('pbkdf2')
  })

  // 30
  it('patches with no provider and params.rehash, and the hashPassword hook does not hash twice', async () => {
    const ctx = await createAuthApp({ config: { local: { iterations: 200000 } } })
    const user = ctx.users.seed({
      email: 'a@example.com',
      password: await createPbkdf2Hasher(100000).hash('pw')
    })

    await ctx.login({ strategy: 'local', email: 'a@example.com', password: 'pw' })

    const [call] = ctx.users.patchCalls

    expect(call.params.provider).toBeUndefined()
    expect(call.params.rehash).toBe(true)

    const stored = ctx.users.records.find((r) => r.id === user.id)!.password

    expect(await createPbkdf2Hasher(200000).verify('pw', stored)).toBe(true)
  })

  it('exports a default pbkdf2Hasher', () => {
    expect(typeof pbkdf2Hasher.hash).toBe('function')
  })
})
