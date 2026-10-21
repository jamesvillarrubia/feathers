import { CombinedChannel } from '../channel/combined.js'
import { Application, HookContext, Params } from '../declarations.js'

export type SsePayload = {
  event: string
  data: unknown
  path?: string
}

/**
 * Removes the raw credentials from a connection in place, so the object that channels and publishers
 * hold (and that `channel.connections.includes(connection)` compares) is the same object that was
 * registered. A connection is the params of a long-lived stream, so it must not carry the original
 * `Request`, the `authorization` header, `authentication.accessToken` or the user's password.
 */
function sanitizeConnection(app: Application, connection: Params) {
  const conn = connection as Record<string, any>
  const authApp = app as any
  let passwordField: string | undefined
  let entityKey = 'user'

  try {
    const config = authApp.service(authApp.get('defaultAuthentication') ?? 'authentication').configuration

    passwordField = config?.local?.passwordField
    entityKey = config?.entity === null ? '' : (config?.entity ?? 'user')
  } catch {
    // No authentication service: nothing beyond the request and header to remove.
  }

  delete conn.request

  if (conn.headers) {
    conn.headers = Object.fromEntries(
      Object.entries(conn.headers).filter(([name]) => name.toLowerCase() !== 'authorization')
    )
  }

  if (conn.authentication) {
    const { accessToken: _token, ...authentication } = conn.authentication
    conn.authentication = authentication
  }

  if (entityKey && passwordField && conn[entityKey] && typeof conn[entityKey] === 'object') {
    const { [passwordField]: _password, ...entity } = conn[entityKey]
    conn[entityKey] = entity
  }
}

export class SseService {
  app?: Application
  path?: string

  async find(connection: Params) {
    const eventBuffer: SsePayload[] = []
    const { app, path } = this

    if (!app || !path) {
      throw new Error('Can not initialize SSE. Did you call app.setup()?')
    }

    let isActive = true
    let pendingResolve: (() => void) | null = null

    const publishHandler = (event: string, channel: CombinedChannel, hook: HookContext, data: unknown) => {
      if (isActive && channel.connections.includes(connection)) {
        const eventData = channel.dataFor ? (channel.dataFor(connection) ?? data) : data
        eventBuffer.push({
          event,
          data: eventData,
          path: hook.path
        })

        if (pendingResolve) {
          pendingResolve()
          pendingResolve = null
        }
      }
    }

    // A connection authenticated with a token ends when the token expires.
    const exp = (connection as { authentication?: { payload?: { exp?: unknown } } }).authentication?.payload
      ?.exp
    const expiresIn = typeof exp === 'number' ? Math.max(0, exp * 1000 - Date.now()) : Infinity
    // setTimeout overflows past 2^31 - 1 ms (about 24 days) and would fire at once
    const expiryTimer =
      expiresIn <= 2147483647
        ? setTimeout(() => {
            isActive = false
            pendingResolve?.()
            pendingResolve = null
          }, expiresIn)
        : undefined

    sanitizeConnection(app, connection)
    app.emit('connection', connection)
    app.addListener('publish', publishHandler)

    const stream = async function* () {
      try {
        yield {
          event: 'connected',
          data: connection.query || {},
          path
        }

        while (isActive) {
          while (eventBuffer.length > 0) {
            yield eventBuffer.shift()!
          }

          // The token can expire while the generator is suspended at a yield above.
          if (!isActive) {
            break
          }

          await new Promise<void>((resolve) => {
            pendingResolve = resolve
          })
        }
      } finally {
        isActive = false
        clearTimeout(expiryTimer)
        app.removeListener('publish', publishHandler)
        app.emit('disconnect', connection)
      }
    }

    return stream()
  }

  async setup(app: Application, path: string) {
    this.app = app
    this.path = path
  }
}
