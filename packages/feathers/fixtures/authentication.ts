import { feathers } from '../src/index.js'
import { createHandler, SseService } from '../src/http/index.js'
import {
  AuthenticationService,
  authenticate,
  hashPassword,
  protect,
  type AuthenticationConfig,
  type AuthenticationInput
} from '../src/authentication/index.js'

export const SECRET = 'a-test-secret-that-is-at-least-32-bytes-long'

export interface UserRecord {
  id: number
  email: string
  password: string
  [key: string]: unknown
}

export class MemoryUsers {
  records: UserRecord[] = []
  patchCalls: { id: unknown; data: any; params: any }[] = []
  failPatch = false
  nextId = 1

  async find(params: any = {}) {
    const query = params.query || {}
    const { $limit, ...filters } = query
    const rows = this.records.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))

    return ($limit ? rows.slice(0, $limit) : rows).map((r) => ({ ...r }))
  }

  async get(id: number | string) {
    const found = this.records.find((r) => String(r.id) === String(id))

    if (!found) {
      throw new Error('not found')
    }

    return { ...found }
  }

  async create(data: any, _params: any = {}) {
    const record = { ...data, id: this.nextId++ }

    this.records.push(record)

    return { ...record }
  }

  async patch(id: number, data: any, params: any = {}) {
    this.patchCalls.push({ id, data, params })

    if (this.failPatch) {
      throw new Error('patch failed')
    }

    const found = this.records.find((r) => r.id === id)!

    Object.assign(found, data)

    return { ...found }
  }

  /** Inserts a record without running any hook, with the stored password exactly as given. */
  seed(record: Omit<UserRecord, 'id'>) {
    const user = { ...record, id: this.nextId++ } as UserRecord

    this.records.push(user)

    return user
  }
}

class MessagesService {
  // Held in an object because `app.use` wraps the service, so `this` is not the registered instance.
  seen: { params: any } = { params: {} }

  async find(params: any = {}) {
    this.seen.params = params

    return [{ text: 'hello' }]
  }

  async create(data: any) {
    return data
  }
}

class ReportsService {
  // Held in an object because `app.use` wraps the service, so `this` is not the registered instance.
  seen: { params: any } = { params: {} }

  async find(params: any) {
    this.seen.params = params

    return [{ report: 1 }]
  }
}

export interface AuthAppOptions {
  config?: Partial<AuthenticationInput>
}

export async function createAuthApp(options: AuthAppOptions = {}) {
  const logs: string[] = []
  const users = new MemoryUsers()
  const reports = new ReportsService()
  const app = feathers<any>()

  app.use(
    'authentication',
    new AuthenticationService({
      secret: SECRET,
      service: 'users',
      authStrategies: ['jwt', 'local'],
      local: { iterations: 100000 },
      logger: { error: (message: string) => logs.push(message) },
      ...options.config
    } as AuthenticationConfig)
  )
  app.use('users', users)
  const messages = new MessagesService()

  app.use('messages', messages)
  app.use('reports', reports)
  app.use('sse', new SseService())

  app.service('users').hooks({
    around: {
      all: [protect('password')],
      create: [hashPassword('password')],
      patch: [hashPassword('password')]
    }
  })
  app.service('messages').hooks({ around: { all: [authenticate('jwt')] } })
  app.service('reports').hooks({ around: { all: [authenticate('api-key')] } })
  app.service('sse').hooks({ around: { find: [authenticate('jwt')] } })

  await app.setup()

  const handler = createHandler(app)
  const call = (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ) =>
    handler(
      new Request(`http://localhost${path}`, {
        method: init.method,
        headers: {
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...init.headers
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined
      })
    ) as Promise<Response>

  const login = (body: Record<string, unknown>) => call('/authentication', { method: 'POST', body })

  return { app, users, reports, messages, handler, call, login, logs }
}
