import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { feathers } from 'feathers'
import { createHandler } from 'feathers/http'
import { AuthenticationService, hashPassword, protect } from 'feathers/authentication'
import { KyselyService } from '../src/index.js'
import { createDb } from './helpers.js'

// Done when 31: local login against a Postgres users table that stores a PBKDF2 hash.
interface AuthUsersTable {
  id: number
  email: string
  password: string
}

interface AuthDatabase {
  auth_users: AuthUsersTable
}

const db = createDb()
const authDb = db as unknown as Kysely<AuthDatabase>
const app = feathers<any>()
const handler = createHandler(app)

app.use(
  'authentication',
  new AuthenticationService({
    secret: 'a-test-secret-that-is-at-least-32-bytes-long',
    service: 'auth-users',
    authStrategies: ['jwt', 'local'],
    local: { iterations: 100000 }
  })
)
app.use(
  'auth-users',
  new KyselyService<AuthDatabase, 'auth_users'>({
    db: authDb,
    table: 'auth_users',
    columns: ['id', 'email', 'password']
  })
)
app.service('auth-users').hooks({
  around: { all: [protect('password')], create: [hashPassword('password')] }
})

const login = (body: unknown) =>
  handler(
    new Request('http://localhost/authentication', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  )

beforeAll(async () => {
  await sql`drop table if exists auth_users`.execute(authDb)
  await authDb.schema
    .createTable('auth_users')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('email', 'text', (col) => col.notNull().unique())
    // A PBKDF2 hash is about 90 characters, so the column is wider than varchar(50)
    .addColumn('password', 'varchar(255)', (col) => col.notNull())
    .execute()
  await app.setup()
  await app.service('auth-users').create({ email: 'a@example.com', password: 'secret' })
})

afterAll(async () => {
  await sql`drop table if exists auth_users`.execute(authDb)
  await db.destroy()
})

describe('local login against Postgres', () => {
  it('stores a pbkdf2-sha256 hash, not the password', async () => {
    const rows = await sql<{ password: string }>`select password from auth_users`.execute(authDb)

    expect(rows.rows[0].password.startsWith('pbkdf2-sha256$')).toBe(true)
    expect(rows.rows[0].password).not.toContain('secret')
  })

  it('returns 201 with an accessToken for the right password', async () => {
    const res = await login({ strategy: 'local', email: 'a@example.com', password: 'secret' })
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(typeof body.accessToken).toBe('string')
    expect(JSON.stringify(body)).not.toContain('password')
  })

  it('returns 401 Invalid login for a wrong password', async () => {
    const res = await login({ strategy: 'local', email: 'a@example.com', password: 'wrong' })

    expect(res.status).toBe(401)
    expect((await res.json()).message).toBe('Invalid login')
  })
})

describe('protect against query probing on Postgres', () => {
  const get = (path: string) => handler(new Request(`http://localhost${path}`))

  it.each([
    '/auth-users?password[$like]=pbkdf2-sha256$6%25',
    '/auth-users?$sort[password]=1',
    '/auth-users?$select[]=password',
    '/auth-users?$or[0][password][$like]=pbkdf2%25'
  ])('rejects %s with 400', async (path) => {
    expect((await get(path)).status).toBe(400)
  })

  it('answers a query on other columns without the password key', async () => {
    const res = await get('/auth-users?email=a@example.com')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(JSON.stringify(body)).not.toContain('password')
    expect(JSON.stringify(body)).toContain('a@example.com')
  })
})
