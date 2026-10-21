import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { feathers } from 'feathers'
import { createHandler } from 'feathers/http'
import { KyselyService } from '../src/index.js'
import { createDb, createTables, dropTables, truncate } from './helpers.js'
import type { Database } from './helpers.js'

const db = createDb()
const app = feathers()
const handler = createHandler(app)

app.use(
  'users',
  new KyselyService<Database, 'users'>({
    db,
    table: 'users',
    columns: ['id', 'email', 'name', 'age'],
    paginate: { default: 10, max: 50 }
  })
)

const request = (path: string, init?: RequestInit) => handler(new Request(`http://localhost${path}`, init))

const post = (path: string, body: unknown) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

beforeAll(async () => {
  await createTables(db)
})

afterAll(async () => {
  await dropTables(db)
  await db.destroy()
})

beforeEach(async () => {
  await truncate(db)
})

describe('unique violation', () => {
  it('returns 409 Conflict for a second insert of the same email', async () => {
    const first = await post('/users', { email: 'a@x.io' })
    expect(first.status).toBe(201)

    const second = await post('/users', { email: 'a@x.io' })
    expect(second.status).toBe(409)

    const body = await second.json()
    expect(body.name).toBe('Conflict')
  })
})

describe('GET /users pagination, sort and operators', () => {
  it('returns { total, limit, skip, data } sorted by age desc with every age > 18', async () => {
    const ages = [10, 19, 25, 40, 33, 18, 51]
    for (const [i, age] of ages.entries()) {
      await post('/users', { email: `u${i}@x.io`, name: `user${i}`, age })
    }

    const res = await request('/users?$limit=2&$skip=1&$sort[age]=-1&age[$gt]=18')
    expect(res.status).toBe(200)

    const body = await res.json()
    // ages above 18, descending: 51, 40, 33, 25, 19
    expect(body.total).toBe(5)
    expect(body.limit).toBe(2)
    expect(body.skip).toBe(1)
    expect(body.data.map((row: { age: number }) => row.age)).toEqual([40, 33])
    expect(body.data.every((row: { age: number }) => row.age > 18)).toBe(true)
  })
})

describe('query validation over HTTP', () => {
  it('returns 400 for an unknown $ parameter', async () => {
    const res = await request('/users?$foo=1')
    expect(res.status).toBe(400)
    expect((await res.json()).message).toBe('Invalid query parameter $foo')
  })

  it('returns 400 for a query key outside columns', async () => {
    const res = await request('/users?nope=1')
    expect(res.status).toBe(400)
    expect((await res.json()).message).toBe("Invalid column 'nope'")
  })

  it('returns 400 for a $select entry outside columns', async () => {
    const res = await request('/users?$select[]=nope')
    expect(res.status).toBe(400)
    expect((await res.json()).message).toBe("Invalid column 'nope'")
  })

  it('returns 400 for a $sort key outside columns', async () => {
    const res = await request('/users?$sort[nope]=1')
    expect(res.status).toBe(400)
    expect((await res.json()).message).toBe("Invalid column 'nope'")
  })

  it('returns 400 for a column outside columns nested in $or', async () => {
    const res = await request('/users?$or[0][nope]=1')
    expect(res.status).toBe(400)
    expect((await res.json()).message).toBe("Invalid column 'nope'")
  })

  it('returns 400 for a dotted key', async () => {
    const res = await request('/users?profile.age=1')
    expect(res.status).toBe(400)
    expect((await res.json()).message).toBe("Invalid column 'profile.age'")
  })

  it('returns 400 for a $sort value other than 1 and -1', async () => {
    const res = await request('/users?$sort[age]=2')
    expect(res.status).toBe(400)
  })

  it('returns 400 for an unknown operator on a column', async () => {
    const res = await request('/users?age[$regex]=1')
    expect(res.status).toBe(400)
    expect((await res.json()).message).toBe('Invalid query parameter $regex')
  })
})
