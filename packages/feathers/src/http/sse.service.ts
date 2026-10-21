import { CombinedChannel } from '../channel/combined.js'
import { Application, HookContext, Params } from '../declarations.js'

export type SsePayload = {
  event: string
  data: unknown
  path?: string
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
