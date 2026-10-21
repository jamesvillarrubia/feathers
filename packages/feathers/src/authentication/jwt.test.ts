import { describe, it, expect } from 'vitest'
import { SignJWT, jwtVerify } from 'jose'
import { signJwt, verifyJwt, base64urlDecode, base64urlEncode } from './jwt.js'

const secret = 'a-test-secret-that-is-at-least-32-bytes-long'

describe('jwt', () => {
  it('base64url round trips bytes', () => {
    const bytes = new Uint8Array([251, 255, 254, 0, 1])

    expect(base64urlEncode(bytes)).toBe('-__-AAE')
    expect([...base64urlDecode('-__-AAE')]).toEqual([...bytes])
  })

  // Done when 11
  it('a token minted here verifies with jose', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const token = await signJwt({ sub: '1', iss: 'feathers', exp }, secret)
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { issuer: 'feathers' })

    expect(payload.sub).toBe('1')
    expect(payload.exp).toBe(exp)
  })

  it('verifies a token minted by jose', async () => {
    const token = await new SignJWT({ sub: '7' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('feathers')
      .setExpirationTime('1m')
      .sign(new TextEncoder().encode(secret))
    const payload = await verifyJwt(token, secret, { issuer: 'feathers' })

    expect(payload.sub).toBe('7')
  })

  // Done when 11, RFC 7515 appendix A.1
  it('verifies the RFC 7515 HS256 vector', async () => {
    const key = base64urlDecode(
      'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow'
    )
    const token =
      'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.' +
      'eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.' +
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const payload = await verifyJwt(token, key, { issuer: 'joe', now: 1300819379 })

    expect(payload.iss).toBe('joe')
    // The RFC vector has no tampering room: a changed payload fails.
    const [h, , s] = token.split('.')
    const forged = `${h}.${base64urlEncode(JSON.stringify({ iss: 'joe', exp: 1300819380 }))}.${s}`

    await expect(verifyJwt(forged, key, { now: 1300819379 })).rejects.toMatchObject({ code: 401 })
  })

  it('rejects a token without exp, with nbf in the future, or with the wrong issuer or audience', async () => {
    const now = Math.floor(Date.now() / 1000)
    const noExp = await signJwt({ sub: '1', iss: 'feathers' }, secret)
    const early = await signJwt({ sub: '1', iss: 'feathers', exp: now + 60, nbf: now + 30 }, secret)
    const other = await signJwt({ sub: '1', iss: 'other', exp: now + 60 }, secret)
    const good = await signJwt({ sub: '1', iss: 'feathers', exp: now + 60, aud: 'a' }, secret)

    await expect(verifyJwt(noExp, secret, { issuer: 'feathers' })).rejects.toMatchObject({ code: 401 })
    await expect(verifyJwt(early, secret, { issuer: 'feathers' })).rejects.toMatchObject({ code: 401 })
    await expect(verifyJwt(other, secret, { issuer: 'feathers' })).rejects.toMatchObject({ code: 401 })
    await expect(verifyJwt(good, secret, { issuer: 'feathers', audience: 'b' })).rejects.toMatchObject({
      code: 401
    })
    await expect(verifyJwt(good, secret, { issuer: 'feathers', audience: 'a' })).resolves.toBeTruthy()
  })

  // Done when 6: the signature is valid HMAC-SHA256 over the secret, so only the alg check can reject it.
  it.each(['none', 'HS512', 'hs256'])(
    'rejects a correctly signed token whose header says alg %s',
    async (alg) => {
      const now = Math.floor(Date.now() / 1000)
      const signingInput = `${base64urlEncode(JSON.stringify({ alg, typ: 'JWT' }))}.${base64urlEncode(
        JSON.stringify({ sub: '1', iss: 'feathers', exp: now + 60 })
      )}`
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      )
      const signature = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
      )
      const token = `${signingInput}.${base64urlEncode(signature)}`

      await expect(verifyJwt(token, secret, { issuer: 'feathers' })).rejects.toMatchObject({ code: 401 })
    }
  )
})
