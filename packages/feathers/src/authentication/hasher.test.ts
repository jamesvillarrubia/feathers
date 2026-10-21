import { describe, it, expect, vi } from 'vitest'
import { createPbkdf2Hasher, pbkdf2Hasher, pbkdf2HashWithSalt, timingSafeEqual } from './hasher.js'

describe('pbkdf2 hasher', () => {
  it('writes pbkdf2-sha256$<iterations>$<salt>$<hash> with a 16 byte salt and 32 byte key', async () => {
    const hash = await createPbkdf2Hasher(100000).hash('secret')
    const [prefix, iterations, salt, key] = hash.split('$')

    expect(prefix).toBe('pbkdf2-sha256')
    expect(iterations).toBe('100000')
    expect(atob(salt).length).toBe(16)
    expect(atob(key).length).toBe(32)
  })

  // Done when 12
  it('a hash at 100000 iterations still verifies after the configured count rises to 200000', async () => {
    const old = await createPbkdf2Hasher(100000).hash('secret')
    const raised = createPbkdf2Hasher(200000)

    expect(await raised.verify('secret', old)).toBe(true)
    expect(await raised.verify('wrong', old)).toBe(false)
    expect(raised.needsRehash(old)).toBe(true)
    expect(createPbkdf2Hasher(100000).needsRehash(old)).toBe(false)
  })

  it('needsRehash is true for an unknown prefix and verify is false', async () => {
    expect(pbkdf2Hasher.needsRehash('$2b$10$abc')).toBe(true)
    expect(await pbkdf2Hasher.verify('x', '$2b$10$abc')).toBe(false)
  })

  it('timingSafeEqual visits every byte of the longer input', () => {
    const visits = { count: 0 }

    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([9, 2, 3]), visits)).toBe(false)
    expect(visits.count).toBe(3)
    visits.count = 0
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 0, 0]), visits)).toBe(false)
    expect(visits.count).toBe(3)
  })

  // S3
  it('treats a stored count above 10,000,000 as invalid without deriving a key', async () => {
    const valid = await createPbkdf2Hasher(100000).hash('secret')
    const [, , salt, key] = valid.split('$')
    const huge = `pbkdf2-sha256$10000001$${salt}$${key}`
    const spy = vi.spyOn(crypto.subtle, 'deriveBits')

    try {
      expect(await pbkdf2Hasher.verify('secret', huge)).toBe(false)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('still verifies a low stored count and flags it for rehash', async () => {
    const low = await pbkdf2HashWithSalt('secret', new Uint8Array(16).fill(1), 1000)

    expect(await pbkdf2Hasher.verify('secret', low)).toBe(true)
    expect(pbkdf2Hasher.needsRehash(low)).toBe(true)
  })

  // S2
  it('verify returns false and needsRehash true for undecodable hashes instead of throwing', async () => {
    for (const bad of ['pbkdf2-sha256$600000$!!$!!', 'pbkdf2-sha256$600000$a$b']) {
      expect(await pbkdf2Hasher.verify('x', bad)).toBe(false)
      expect(pbkdf2Hasher.needsRehash(bad)).toBe(true)
    }
  })
})
