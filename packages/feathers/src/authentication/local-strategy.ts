import type { Application, Params } from '../declarations.js'
import { NotAuthenticated } from '../errors.js'
import { createPbkdf2Hasher, type PasswordHasher } from './hasher.js'
import type {
  AuthenticationRequest,
  AuthenticationResult,
  AuthenticationServiceLike,
  AuthenticationStrategy
} from './types.js'

export class LocalStrategy implements AuthenticationStrategy {
  name = 'local'
  authentication!: AuthenticationServiceLike
  app?: Application
  private dummyHash?: string

  setName(name: string) {
    this.name = name
  }

  setAuthentication(authentication: AuthenticationServiceLike) {
    this.authentication = authentication
  }

  setApplication(app: Application) {
    this.app = app
  }

  get settings() {
    return this.authentication.configuration.local!
  }

  get hasher(): PasswordHasher {
    return this.settings.hasher ?? createPbkdf2Hasher(this.settings.iterations)
  }

  /** Builds the hash the unknown-email path verifies against, with the configured hasher. */
  async setup() {
    this.dummyHash = await this.hasher.hash('dummy')
  }

  hashPassword(password: string) {
    return this.hasher.hash(password)
  }

  async authenticate(request: AuthenticationRequest, _params: Params): Promise<AuthenticationResult> {
    const { usernameField, passwordField } = this.settings
    const { entity, service, logger } = this.authentication.configuration
    const username = request[usernameField]
    const password = request[passwordField]
    const fail = () => new NotAuthenticated('Invalid login')

    if (typeof username !== 'string' || typeof password !== 'string') {
      throw fail()
    }

    const usersService = this.app!.service(service)
    const found: any = await usersService.find({ query: { [usernameField]: username, $limit: 1 } })
    const user = (Array.isArray(found) ? found : found?.data)?.[0]
    const storedHash = user?.[passwordField]

    if (!user || typeof storedHash !== 'string') {
      // Spend the same hashing time as a real check so timing does not reveal the account.
      await this.hasher.verify(password, this.dummyHash ?? (await this.hasher.hash('dummy')))
      throw fail()
    }

    if (!(await this.hasher.verify(password, storedHash))) {
      throw fail()
    }

    if (this.hasher.needsRehash(storedHash)) {
      await this.rehash(user, password, logger)
    }

    return {
      authentication: { strategy: this.name },
      [entity ?? 'user']: user
    }
  }

  private async rehash(user: Record<string, any>, password: string, logger: { error(m: string): void }) {
    const { passwordField, iterations } = this.settings
    const { entityId, service } = this.authentication.configuration
    const idField = entityId ?? (this.app!.service(service) as any).id ?? 'id'

    try {
      const newHash = await createPbkdf2Hasher(iterations).hash(password)

      // No provider: external-access guards on the users service do not run.
      await this.app!.service(service).patch(user[idField], { [passwordField]: newHash }, {
        rehash: true
      } as Params)
      user[passwordField] = newHash
    } catch (_error) {
      // Log the id only; never the password, a hash, or the error (it may echo either).
      logger.error(`Password rehash failed for user ${String(user[idField])}`)
    }
  }
}
