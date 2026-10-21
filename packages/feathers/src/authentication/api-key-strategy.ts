import type { Params } from '../declarations.js'
import { NotAuthenticated } from '../errors.js'
import { timingSafeEqual } from './hasher.js'
import type {
  AuthenticationConfig,
  AuthenticationRequest,
  AuthenticationResult,
  AuthenticationServiceLike,
  AuthenticationStrategy
} from './types.js'

const encoder = new TextEncoder()

const digest = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))

/**
 * Compares `submitted` to every entry of `keys` through SHA-256 digests, so every comparison
 * runs over equal-length arrays. The loop never returns early. `visits` counts digest bytes
 * compared (used by tests).
 */
export async function matchApiKey(submitted: string, keys: string[], visits?: { count: number }) {
  const submittedDigest = await digest(submitted)
  let matched = false

  for (const key of keys) {
    const equal = timingSafeEqual(submittedDigest, await digest(key), visits)

    matched = matched || equal
  }

  return matched
}

type ApiKeyOptions = NonNullable<AuthenticationConfig['apiKey']>

/** Throws when `apiKey` does not set exactly one of `keys` and `verify`. */
export function checkApiKeyConfig(apiKey: ApiKeyOptions | undefined) {
  if (apiKey && Boolean(apiKey.keys) === Boolean(apiKey.verify)) {
    throw new Error('The `apiKey` option must set exactly one of `keys` or `verify`')
  }

  if (
    apiKey?.keys &&
    !(Array.isArray(apiKey.keys) && apiKey.keys.every((key) => typeof key === 'string' && key !== ''))
  ) {
    throw new Error('Every `apiKey.keys` entry must be a non-empty string (is the environment variable set?)')
  }
}

export class ApiKeyStrategy implements AuthenticationStrategy {
  name = 'api-key'
  authentication!: AuthenticationServiceLike

  setName(name: string) {
    this.name = name
  }

  setAuthentication(authentication: AuthenticationServiceLike) {
    this.authentication = authentication
  }

  get settings() {
    return this.authentication.configuration.apiKey!
  }

  async parse(request: Request): Promise<AuthenticationRequest | null> {
    const apiKey = request.headers.get(this.settings.header ?? 'x-api-key')

    return apiKey ? { strategy: this.name, apiKey } : null
  }

  async authenticate(request: AuthenticationRequest, params: Params): Promise<AuthenticationResult> {
    const { keys, verify } = this.settings
    const { apiKey } = request
    const fail = () => new NotAuthenticated('Invalid login')

    if (typeof apiKey !== 'string') {
      throw fail()
    }

    let result: Record<string, unknown> | null

    if (verify) {
      result = await verify(apiKey, params)
    } else {
      result = (await matchApiKey(apiKey, keys ?? [])) ? {} : null
    }

    if (!result) {
      throw fail()
    }

    // The key itself is never copied into the result.
    return { authentication: { strategy: this.name }, apiKey: result }
  }
}
