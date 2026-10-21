import type { HookContext, NextFunction } from '../declarations.js'
import { BadRequest, NotAuthenticated } from '../errors.js'
import type { AuthenticationService } from './service.js'
import type { AuthenticationRequest, AuthParams } from './types.js'
import type { LocalStrategy } from './local-strategy.js'

function getAuthService(context: HookContext): AuthenticationService {
  const app = context.app as any
  const path = app.get('defaultAuthentication') ?? 'authentication'

  return app.service(path)
}

export function authenticate(...strategies: string[]) {
  if (strategies.length === 0) {
    throw new Error('The `authenticate` hook needs at least one strategy name')
  }

  return async (context: HookContext, next: NextFunction) => {
    const app = context.app as any
    const authPath = app.get('defaultAuthentication') ?? 'authentication'

    if (context.path === authPath) {
      throw new NotAuthenticated(
        'The authenticate hook does not need to be used on the authentication service'
      )
    }

    const params = (context.params || {}) as AuthParams

    if (params.authenticated) {
      return next()
    }

    const authService = getAuthService(context)
    let credentials = params.authentication as AuthenticationRequest | undefined

    if (!credentials && params.provider) {
      const request = new Request('http://localhost/', { headers: new Headers(params.headers ?? {}) })

      for (const name of strategies) {
        const parsed = await authService.getStrategy(name)?.parse?.(request)

        if (parsed) {
          credentials = parsed
          break
        }
      }
    }

    if (credentials) {
      const result = await authService.authenticate(credentials, params, ...strategies)
      const { accessToken: _dropped, ...rest } = result
      const { passwordField } = authService.configuration.local ?? {}
      const entityKey =
        authService.configuration.entity === null ? undefined : (authService.configuration.entity ?? 'user')

      // The params outlive the call (an SSE connection keeps them), so they carry no raw token or password.
      if (rest.authentication) {
        const { accessToken: _token, ...authentication } = rest.authentication as Record<string, unknown>

        rest.authentication = authentication as typeof rest.authentication
      }

      if (entityKey && passwordField && rest[entityKey] && typeof rest[entityKey] === 'object') {
        const { [passwordField]: _password, ...entity } = rest[entityKey] as Record<string, unknown>

        rest[entityKey] = entity
      }

      const headers = params.headers
        ? Object.fromEntries(
            Object.entries(params.headers).filter(([name]) => name.toLowerCase() !== 'authorization')
          )
        : undefined

      context.params = { ...params, ...rest, ...(headers ? { headers } : {}), authenticated: true } as any
    } else if (params.provider) {
      throw new NotAuthenticated('Invalid login')
    }

    return next()
  }
}

function omit(value: any, fields: string[]) {
  if (value === null || typeof value !== 'object') {
    return value
  }

  const copy = { ...value }

  fields.forEach((field) => delete copy[field])

  return copy
}

/**
 * Removes `fields` from the results of external calls and rejects with `BadRequest` any external query
 * that filters, sorts or selects on one of them (including inside `$or` and `$and`), so the stored values
 * can not be probed through query results.
 */
export function protect(...fields: string[]) {
  return async (context: HookContext, next: NextFunction) => {
    if (context.params?.provider && context.params.query) {
      const { query } = context.params

      // A string value is a field name only under $select; elsewhere it is data (e.g. `email=password`).
      const bad = (value: unknown, inSelect = false): boolean => {
        if (typeof value === 'string') {
          return inSelect && fields.includes(value.split('.')[0])
        }

        if (Array.isArray(value)) {
          return value.some((item) => bad(item, inSelect))
        }

        if (value !== null && typeof value === 'object') {
          return Object.entries(value).some(([key, inner]) =>
            key === '$select'
              ? bad(inner, true)
              : fields.includes(key.split('.')[0]) || (inSelect ? bad(inner, true) : bad(inner))
          )
        }

        return false
      }

      if (bad(query)) {
        throw new BadRequest('Invalid query')
      }
    }

    await next()

    if (!context.params?.provider || context.result === undefined) {
      return
    }

    const { result } = context

    if (Array.isArray(result)) {
      context.result = result.map((item) => omit(item, fields))
    } else if (result && Array.isArray(result.data)) {
      context.result = { ...result, data: result.data.map((item: unknown) => omit(item, fields)) }
    } else {
      context.result = omit(result, fields)
    }
  }
}

/** Hashes `field` on create and patch through the local strategy, unless the call carries `params.rehash`. */
export function hashPassword(field: string) {
  return async (context: HookContext, next: NextFunction) => {
    if (!(context.params as AuthParams)?.rehash && context.data) {
      const strategy = getAuthService(context).getStrategy('local') as LocalStrategy | undefined

      if (!strategy) {
        throw new Error('hashPassword needs the local strategy')
      }

      const hashOne = async (item: Record<string, any>) =>
        typeof item?.[field] === 'string'
          ? { ...item, [field]: await strategy.hashPassword(item[field]) }
          : item

      context.data = Array.isArray(context.data)
        ? await Promise.all(context.data.map(hashOne))
        : await hashOne(context.data)
    }

    return next()
  }
}
