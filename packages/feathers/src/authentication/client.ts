import type { Application, HookContext, NextFunction } from '../declarations.js'
import { NotAuthenticated } from '../errors.js'
import { decodeJwtPayload } from './jwt.js'
import type { AuthenticationRequest } from './types.js'

export interface TokenStorage {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

export class MemoryStorage implements TokenStorage {
  private store: Record<string, string> = {}

  getItem(key: string) {
    return this.store[key] ?? null
  }

  setItem(key: string, value: string) {
    this.store[key] = value
  }

  removeItem(key: string) {
    delete this.store[key]
  }
}

export interface AuthenticationClientOptions {
  /** Defaults to an in-memory store. Pass `localStorage` to persist. */
  storage?: TokenStorage
  header?: string
  storageKey?: string
  path?: string
}

export function authenticationClient(options: AuthenticationClientOptions = {}) {
  const {
    storage = new MemoryStorage(),
    header = 'Authorization',
    storageKey = 'feathers-jwt',
    path = 'authentication'
  } = options

  return (app: Application) => {
    const client = app as any

    client.hooks({
      around: {
        all: [
          async (context: HookContext, next: NextFunction) => {
            const accessToken = await storage.getItem(storageKey)

            if (accessToken) {
              context.params = {
                ...context.params,
                headers: { [header]: `Bearer ${accessToken}`, ...context.params?.headers }
              }
            }

            return next()
          }
        ]
      }
    })

    client.authenticate = async (authentication: AuthenticationRequest) => {
      await storage.removeItem(storageKey)

      const result = await app.service(path).create(authentication)

      await storage.setItem(storageKey, result.accessToken)

      return result
    }

    client.reAuthenticate = async () => {
      const accessToken = await storage.getItem(storageKey)

      if (!accessToken) {
        throw new NotAuthenticated('No accessToken found in storage')
      }

      const payload = decodeJwtPayload(accessToken)

      // An expired token is rejected here; the client never asks for a new one.
      if (!payload || typeof payload.exp !== 'number' || payload.exp <= Date.now() / 1000) {
        await storage.removeItem(storageKey)
        throw new NotAuthenticated('The stored accessToken has expired')
      }

      const result = await app.service(path).remove(null)

      return { accessToken, ...result }
    }

    client.logout = async () => {
      await storage.removeItem(storageKey)
    }
  }
}
