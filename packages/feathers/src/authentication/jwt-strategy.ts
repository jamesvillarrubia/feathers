import type { Application, Params } from '../declarations.js'
import { NotAuthenticated } from '../errors.js'
import { verifyJwt } from './jwt.js'
import type {
  AuthenticationRequest,
  AuthenticationResult,
  AuthenticationServiceLike,
  AuthenticationStrategy
} from './types.js'

export class JwtStrategy implements AuthenticationStrategy {
  name = 'jwt'
  authentication!: AuthenticationServiceLike
  app?: Application

  setName(name: string) {
    this.name = name
  }

  setAuthentication(authentication: AuthenticationServiceLike) {
    this.authentication = authentication
  }

  setApplication(app: Application) {
    this.app = app
  }

  async parse(request: Request): Promise<AuthenticationRequest | null> {
    const header = request.headers.get('authorization')
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null

    return match ? { strategy: this.name, accessToken: match[1] } : null
  }

  async verify(accessToken: unknown) {
    if (typeof accessToken !== 'string') {
      throw new NotAuthenticated('Invalid authentication information')
    }

    const { secret, jwt } = this.authentication.configuration

    return verifyJwt(accessToken, secret, {
      algorithm: jwt.algorithm,
      issuer: jwt.issuer,
      audience: jwt.audience
    })
  }

  async authenticate(request: AuthenticationRequest, _params: Params): Promise<AuthenticationResult> {
    const { accessToken } = request
    const payload = await this.verify(accessToken)
    const { entity, service } = this.authentication.configuration
    const result: AuthenticationResult = {
      authentication: { strategy: this.name, accessToken: accessToken as string, payload }
    }

    if (entity === null) {
      return result
    }

    if (payload.sub === undefined) {
      throw new NotAuthenticated('Invalid authentication information')
    }

    // No provider on this call, so external-access guards on the users service do not run.
    try {
      result[entity] = await this.app!.service(service).get(payload.sub)
    } catch (_error) {
      throw new NotAuthenticated('Invalid authentication information')
    }

    return result
  }
}
