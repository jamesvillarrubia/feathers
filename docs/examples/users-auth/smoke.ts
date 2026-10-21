import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHandler } from 'feathers/http'
import { toNodeHandler } from 'feathers/http/node'
import { app, db } from './src/app.js'

await app.setup()

const server = createServer(toNodeHandler(createHandler(app)))
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const call = async (path: string, init: { body?: object; token?: string } = {}) => {
  const res = await fetch(base + path, {
    method: init.body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {})
    },
    body: init.body ? JSON.stringify(init.body) : undefined
  })
  return { status: res.status, json: (await res.json()) as any }
}

const creds = { email: `smoke-${Date.now()}@example.com`, password: 'secret-pass' }
const failures: string[] = []
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
  if (!ok) failures.push(name)
}

try {
  check('POST /users', (await call('/users', { body: creds })).status, 201)
  const login = await call('/authentication', { body: { strategy: 'local', ...creds } })
  check('POST /authentication', login.status, 201)
  check('GET /messages with token', (await call('/messages', { token: login.json.accessToken })).status, 200)
  check('GET /messages without token', (await call('/messages')).status, 401)
  const users = await call('/users')
  check('GET /users', users.status, 200)
  const rows: any[] = Array.isArray(users.json) ? users.json : users.json.data
  check('GET /users has no password key', rows.some((row) => 'password' in row), false)
} finally {
  server.close()
  await db.destroy()
}

if (failures.length > 0) {
  console.error(`smoke failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('smoke passed')
