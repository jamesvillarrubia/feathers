import type { Application, Params } from '../declarations.js'
import type { PasswordHasher } from './hasher.js'
import type { JwtPayload } from './jwt.js'

export interface AuthenticationConfig {
  /** At least 32 bytes; `setup()` throws otherwise */
  secret: string
  /** Property that holds the loaded entity on params and results. `null` disables entity loading */
  entity: string | null
  /** Users service path, e.g. `users` */
  service: string
  entityId?: string
  /** Strategies that may create a token */
  authStrategies: string[]
  jwt: {
    algorithm: 'HS256'
    /** Seconds */
    expiresIn: number
    issuer: string
    audience?: string
  }
  local?: {
    usernameField: string
    passwordField: string
    iterations: number
    hasher?: PasswordHasher
  }
  /** Set exactly one of `keys` or `verify`. An API key authenticates a request and never mints a token. */
  apiKey?: {
    /** Defaults to `x-api-key` */
    header: string
    keys?: string[]
    verify?: (key: string, params: Params) => Promise<Record<string, unknown> | null>
  }
  /** Receives rehash failures. Defaults to `console`. */
  logger?: { error(message: string): void }
}

export type AuthenticationInput = Partial<Omit<AuthenticationConfig, 'jwt' | 'local' | 'apiKey'>> & {
  apiKey?: Partial<NonNullable<AuthenticationConfig['apiKey']>>
  secret: string
  service: string
  authStrategies: string[]
  jwt?: Partial<AuthenticationConfig['jwt']>
  local?: Partial<NonNullable<AuthenticationConfig['local']>>
}

export interface AuthenticationRequest {
  strategy?: string
  [key: string]: unknown
}

export interface AuthenticationResult {
  accessToken?: string
  authentication?: {
    strategy: string
    accessToken?: string
    payload?: JwtPayload
  }
  [key: string]: unknown
}

export interface AuthenticationStrategy {
  name?: string
  /** Called by the service when the strategy is registered */
  setName?(name: string): void
  setAuthentication?(authentication: AuthenticationServiceLike): void
  setApplication?(app: Application): void
  /** Called by the service's `setup()` after every strategy has its application */
  setup?(): Promise<void>
  authenticate(request: AuthenticationRequest, params: Params): Promise<AuthenticationResult>
  parse?(request: Request): Promise<AuthenticationRequest | null>
}

export interface AuthenticationServiceLike {
  configuration: AuthenticationConfig
  app?: Application
  getStrategy(name: string): AuthenticationStrategy | undefined
}

export type AuthParams = Params & {
  authentication?: AuthenticationRequest | AuthenticationResult['authentication']
  authenticated?: boolean
  user?: Record<string, any>
  rehash?: boolean
}
