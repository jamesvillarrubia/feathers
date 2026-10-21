import { NotAuthenticated } from '../errors.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type JwtPayload = {
  sub?: string
  iss?: string
  aud?: string | string[]
  iat?: number
  exp?: number
  nbf?: number
  [key: string]: unknown
}

export interface VerifyOptions {
  algorithm?: 'HS256'
  issuer?: string
  audience?: string
  /** Current time in seconds. Defaults to `Date.now() / 1000`. Used by tests. */
  now?: number
}

export function base64urlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  let binary = ''

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) {
    throw new Error('Invalid base64url string')
  }

  const padded = input
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(input.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

function importKey(secret: string | Uint8Array, usages: KeyUsage[]) {
  const raw = typeof secret === 'string' ? encoder.encode(secret) : secret

  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, usages)
}

export async function signJwt(payload: JwtPayload, secret: string | Uint8Array): Promise<string> {
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64urlEncode(JSON.stringify(payload))
  const data = `${header}.${body}`
  const key = await importKey(secret, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))

  return `${data}.${base64urlEncode(new Uint8Array(signature))}`
}

const invalid = () => new NotAuthenticated('Invalid authentication information')

function parseJson(part: string): Record<string, any> {
  const value = JSON.parse(decoder.decode(base64urlDecode(part)))

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Not an object')
  }

  return value
}

/**
 * Decodes the payload of a token without verifying it. Only for reading `exp`
 * on the client; never trust the result on a server.
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    return parseJson(token.split('.')[1])
  } catch (_error) {
    return null
  }
}

export async function verifyJwt(
  token: string,
  secret: string | Uint8Array,
  options: VerifyOptions = {}
): Promise<JwtPayload> {
  const { algorithm = 'HS256', issuer, audience, now = Date.now() / 1000 } = options
  const parts = typeof token === 'string' ? token.split('.') : []

  if (parts.length !== 3) {
    throw invalid()
  }

  let header: Record<string, any>
  let payload: JwtPayload
  let signature: Uint8Array

  try {
    header = parseJson(parts[0])
    signature = base64urlDecode(parts[2])
    payload = parseJson(parts[1])
  } catch (_error) {
    throw invalid()
  }

  // Only the configured algorithm is accepted; `none` and anything else fails here.
  if (header.alg !== algorithm) {
    throw invalid()
  }

  const key = await importKey(secret, ['verify'])
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature as BufferSource,
    encoder.encode(`${parts[0]}.${parts[1]}`)
  )

  if (!valid) {
    throw invalid()
  }

  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw invalid()
  }

  if (typeof payload.nbf === 'number' && payload.nbf > now) {
    throw invalid()
  }

  if (issuer !== undefined && payload.iss !== issuer) {
    throw invalid()
  }

  if (audience !== undefined) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]

    if (!aud.includes(audience)) {
      throw invalid()
    }
  }

  return payload
}
