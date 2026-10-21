import type { Application, Params } from '../declarations.js'
import { NotAuthenticated } from '../errors.js'
import { DEFAULT_ITERATIONS, MIN_ITERATIONS } from './hasher.js'
import { ApiKeyStrategy, checkApiKeyConfig } from './api-key-strategy.js'
import { JwtStrategy } from './jwt-strategy.js'
import { signJwt } from './jwt.js'
import { LocalStrategy } from './local-strategy.js'
import type {
  AuthenticationConfig,
  AuthenticationInput,
  AuthenticationRequest,
  AuthenticationResult,
  AuthenticationServiceLike,
  AuthenticationStrategy,
  AuthParams
} from './types.js'

const invalid = () => new NotAuthenticated('Invalid authentication information')

export class AuthenticationService implements AuthenticationServiceLike {
  configuration: AuthenticationConfig
  strategies: Record<string, AuthenticationStrategy> = {}
  app?: Application
  path?: string

  constructor(input: AuthenticationInput) {
    const { jwt, local, apiKey, ...rest } = input

    this.configuration = {
      entity: 'user',
      logger: console,
      ...rest,
      jwt: { algorithm: 'HS256', expiresIn: 86400, issuer: 'feathers', ...jwt },
      ...(local
        ? {
            local: {
              usernameField: 'email',
              passwordField: 'password',
              iterations: DEFAULT_ITERATIONS,
              ...local
            }
          }
        : {}),
      ...(apiKey ? { apiKey: { header: 'x-api-key', ...apiKey } } : {})
    }

    this.register('jwt', new JwtStrategy())

    if (this.configuration.local) {
      this.register('local', new LocalStrategy())
    }

    if (this.configuration.apiKey) {
      this.register('api-key', new ApiKeyStrategy())
    }
  }

  register(name: string, strategy: AuthenticationStrategy) {
    this.strategies[name] = strategy
    strategy.setName?.(name)
    strategy.setAuthentication?.(this)

    if (this.app) {
      strategy.setApplication?.(this.app)
    }

    return this
  }

  getStrategy(name: string) {
    return Object.prototype.hasOwnProperty.call(this.strategies, name) ? this.strategies[name] : undefined
  }

  async setup(app: Application, path: string) {
    const { secret, entity, service, local, authStrategies } = this.configuration

    if (typeof secret !== 'string' || new TextEncoder().encode(secret).length < 32) {
      throw new Error('The authentication `secret` must be at least 32 bytes')
    }

    if (authStrategies.includes('api-key')) {
      throw new Error("'api-key' can not be in `authStrategies`, an API key never mints a token")
    }

    checkApiKeyConfig(this.configuration.apiKey)

    if (local && local.iterations < MIN_ITERATIONS) {
      throw new Error(`The \`local.iterations\` option must be at least ${MIN_ITERATIONS}`)
    }

    if (entity !== null) {
      if (!service) {
        throw new Error('The authentication `service` option is required when `entity` is set')
      }

      let found = true

      try {
        app.service(service)
      } catch (_error) {
        found = false
      }

      if (!found) {
        throw new Error(`Authentication users service '${service}' does not exist`)
      }
    }

    this.app = app
    this.path = path
    ;(app as any).set('defaultAuthentication', path)

    Object.values(this.strategies).forEach((strategy) => strategy.setApplication?.(app))
    await Promise.all(Object.values(this.strategies).map((strategy) => strategy.setup?.()))
  }

  get entityId(): string {
    const { entityId, service } = this.configuration

    return entityId ?? (this.app?.service(service) as any)?.id ?? 'id'
  }

  /** Internal method used by the `authenticate` hook. Not an external method. */
  async authenticate(request: AuthenticationRequest, params: Params, ...allowed: string[]) {
    const names = allowed.length > 0 ? allowed : this.configuration.authStrategies
    const name = request.strategy
    const strategy = typeof name === 'string' ? this.getStrategy(name) : undefined

    if (!strategy || !name || !names.includes(name)) {
      throw invalid()
    }

    return strategy.authenticate(request, { ...params, authenticated: false } as Params)
  }

  private publicResult(result: AuthenticationResult): AuthenticationResult {
    const { entity, local } = this.configuration
    const copy = { ...result }

    delete copy.accessToken

    if (entity !== null && copy[entity] && typeof copy[entity] === 'object') {
      const { [local?.passwordField ?? 'password']: _hash, ...user } = copy[entity] as Record<string, unknown>

      copy[entity] = user
    }

    return copy
  }

  async create(data: AuthenticationRequest, params: Params = {}) {
    const name = data?.strategy

    if (typeof name !== 'string' || !this.configuration.authStrategies.includes(name)) {
      throw invalid()
    }

    const result = await this.authenticate(data, params, name)
    const { entity, jwt } = this.configuration
    const user = entity !== null ? (result[entity] as Record<string, any> | undefined) : undefined
    const sub = user ? String(user[this.entityId]) : result.authentication?.payload?.sub
    const iat = Math.floor(Date.now() / 1000)
    let authTime = iat
    let exp = iat + jwt.expiresIn

    if (name === 'jwt') {
      // A token minted from a token keeps the original login's absolute expiry.
      const presented = result.authentication?.payload

      if (typeof presented?.auth_time !== 'number' || typeof presented.exp !== 'number') {
        throw invalid()
      }

      authTime = presented.auth_time
      exp = presented.exp
    }

    const payload = {
      ...(sub !== undefined ? { sub } : {}),
      iss: jwt.issuer,
      ...(jwt.audience ? { aud: jwt.audience } : {}),
      iat,
      auth_time: authTime,
      exp
    }
    const accessToken = await signJwt(payload, this.configuration.secret)

    return {
      accessToken,
      ...this.publicResult({ ...result, authentication: { strategy: name, payload } })
    }
  }

  /** Tokens are stateless, so this verifies the token and returns the result. */
  async remove(id: string | null, params: AuthParams = {}) {
    let accessToken: unknown = id

    if (accessToken === null || accessToken === undefined) {
      const jwt = this.getStrategy('jwt')
      const request = new Request('http://localhost/', { headers: new Headers(params.headers ?? {}) })

      accessToken = (await jwt?.parse?.(request))?.accessToken
    }

    if (!accessToken) {
      throw invalid()
    }

    return this.publicResult(await this.authenticate({ strategy: 'jwt', accessToken }, params, 'jwt'))
  }
}
