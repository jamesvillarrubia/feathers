import { base64urlDecode } from './jwt.js'

export interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(password: string, hash: string): Promise<boolean>
  /** True when the stored hash should be replaced by the default hasher's format. */
  needsRehash(hash: string): boolean
}

export const PBKDF2_PREFIX = 'pbkdf2-sha256$'
export const DEFAULT_ITERATIONS = 600000
export const MIN_ITERATIONS = 100000
/** Stored counts above this are treated as invalid, so a tampered hash can not pin the CPU. */
export const MAX_ITERATIONS = 10000000

const encoder = new TextEncoder()

function toBase64(bytes: Uint8Array) {
  let binary = ''

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }

  return btoa(binary)
}

function fromBase64(value: string) {
  // Standard base64 and base64url both decode here.
  return base64urlDecode(value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
}

/**
 * Compares two byte arrays and touches every byte, with no early return.
 * `visits` receives the number of bytes visited (used by tests).
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array, visits?: { count: number }): boolean {
  const length = Math.max(a.length, b.length)
  let diff = a.length ^ b.length

  for (let i = 0; i < length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)

    if (visits) {
      visits.count++
    }
  }

  return diff === 0
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256
  )

  return new Uint8Array(bits)
}

function parseHash(hash: string) {
  if (typeof hash !== 'string' || !hash.startsWith(PBKDF2_PREFIX)) {
    return null
  }

  const [, iterations, salt, derived] = hash.split('$')
  const count = Number(iterations)

  if (!Number.isInteger(count) || count < 1 || count > MAX_ITERATIONS || !salt || !derived) {
    return null
  }

  try {
    const parsed = { iterations: count, salt: fromBase64(salt), derived: fromBase64(derived) }

    return parsed.salt.length > 0 && parsed.derived.length === 32 ? parsed : null
  } catch (_error) {
    return null
  }
}

export function pbkdf2HashWithSalt(password: string, salt: Uint8Array, iterations: number) {
  return derive(password, salt, iterations).then(
    (bits) => `${PBKDF2_PREFIX}${iterations}$${toBase64(salt)}$${toBase64(bits)}`
  )
}

export function createPbkdf2Hasher(iterations = DEFAULT_ITERATIONS): PasswordHasher {
  return {
    hash(password) {
      return pbkdf2HashWithSalt(password, crypto.getRandomValues(new Uint8Array(16)), iterations)
    },
    async verify(password, hash) {
      const parsed = parseHash(hash)

      if (!parsed) {
        return false
      }

      const actual = await derive(password, parsed.salt, parsed.iterations)

      return timingSafeEqual(actual, parsed.derived)
    },
    needsRehash(hash) {
      const parsed = parseHash(hash)

      return !parsed || parsed.iterations < iterations
    }
  }
}

export const pbkdf2Hasher = createPbkdf2Hasher()
