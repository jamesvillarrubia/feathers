import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { feathers } from 'feathers'
import { KyselyService, ERROR } from '../src/index.js'
import { createDb, createTables, dropTables, truncate } from './helpers.js'
import type { Database } from './helpers.js'

const db = createDb()
const app = feathers<{ users: KyselyService<Database, 'users'> }>()
const service = new KyselyService<Database, 'users'>({
  db,
  table: 'users',
  columns: ['id', 'email', 'name', 'age'],
  multi: true
})

app.use('users', service)

const users = () => app.service('users')
const names = (rows: { name: string | null }[]) => rows.map((row) => row.name)

beforeAll(async () => {
  await createTables(db)
})

afterAll(async () => {
  await dropTables(db)
  await db.destroy()
})

beforeEach(async () => {
  await truncate(db)
  await users().create([
    { email: 'a@x.io', name: 'Alice', age: 19 },
    { email: 'b@x.io', name: 'Bob', age: 25 },
    { email: 'c@x.io', name: 'Doug', age: null }
  ])
})

describe('query operators', () => {
  it('maps $like, $notlike and $ilike', async () => {
    const like = await users().find({ paginate: false, query: { name: { $like: 'A%' }, $sort: { id: 1 } } })
    expect(names(like)).toEqual(['Alice'])

    const ilike = await users().find({ paginate: false, query: { name: { $ilike: 'a%' } } })
    expect(names(ilike)).toEqual(['Alice'])

    const notlike = await users().find({
      paginate: false,
      query: { name: { $notlike: 'A%' }, $sort: { id: 1 } }
    })
    expect(names(notlike)).toEqual(['Bob', 'Doug'])
  })

  it('matches no rows for $in: [] and all rows for $nin: []', async () => {
    expect(await users().find({ paginate: false, query: { age: { $in: [] } } })).toEqual([])
    expect(await users().find({ paginate: false, query: { age: { $nin: [] } } })).toHaveLength(3)
  })

  it('maps null to IS NULL and $ne: null to IS NOT NULL', async () => {
    const isNull = await users().find({ paginate: false, query: { age: null } })
    expect(names(isNull)).toEqual(['Doug'])

    const notNull = await users().find({ paginate: false, query: { age: { $ne: null }, $sort: { id: 1 } } })
    expect(names(notNull)).toEqual(['Alice', 'Bob'])
  })

  it('combines several operators on one column with AND', async () => {
    const rows = await users().find({ paginate: false, query: { age: { $gt: 19, $lt: 30 } } })
    expect(names(rows)).toEqual(['Bob'])
  })

  it('accepts numeric strings for $limit and $skip as they arrive from HTTP', async () => {
    const rows = await users().find({
      paginate: false,
      query: { $sort: { id: 1 }, $limit: '1', $skip: '1' } as any
    })
    expect(names(rows)).toEqual(['Bob'])
  })

  it('always adds the id column to $select', async () => {
    const rows = await users().find({ paginate: false, query: { $select: ['name'], $sort: { id: 1 } } })
    expect(rows[0]).toEqual({ id: expect.any(Number), name: 'Alice' })
  })

  it('accepts the id column even when columns omits it', async () => {
    const noId = new KyselyService<Database, 'users'>({ db, table: 'users', columns: ['name'] })
    const rows = await noId.find({ paginate: false, query: { id: 1 } })
    expect(names(rows)).toEqual(['Alice'])
  })

  it('returns count as a number when paginated', async () => {
    const paged = new KyselyService<Database, 'users'>({
      db,
      table: 'users',
      columns: ['id', 'name'],
      paginate: { default: 2, max: 5 }
    })
    const page = await paged.find({})
    expect(page).toMatchObject({ total: 3, limit: 2, skip: 0 })
    expect(typeof (page as any).total).toBe('number')
  })
})

describe('writes', () => {
  it('keeps input order when creating an array', async () => {
    const created = await users().create(
      Array.from({ length: 12 }, (_, i) => ({ email: `n${i}@x.io`, name: `n${i}` }))
    )
    expect(names(created)).toEqual(Array.from({ length: 12 }, (_, i) => `n${i}`))
  })

  it('returns [] for an empty array when multi allows create', async () => {
    expect(await users().create([])).toEqual([])
  })

  it('patch(null) updates and returns every matching row in one statement', async () => {
    const patched = await users().patch(null, { age: 50 }, { query: { age: { $ne: null } } })
    expect(patched).toHaveLength(2)
    expect(patched.every((row: { age: number }) => row.age === 50)).toBe(true)
    expect(await users().find({ paginate: false, query: { age: null } })).toHaveLength(1)
  })

  it('patch with an empty payload returns the current row without updating', async () => {
    expect(await users().patch(1, {})).toMatchObject({ id: 1, name: 'Alice' })
    expect(await users().patch(null, {}, { query: { name: 'Bob' } })).toHaveLength(1)
  })

  it('patch strips the id field from the payload', async () => {
    const row = await users().patch(1, { id: 99, name: 'Alicia' } as any)
    expect(row).toMatchObject({ id: 1, name: 'Alicia' })
  })
})

describe('errors', () => {
  it('maps a unique violation to Conflict and keeps the pg error under ERROR', async () => {
    const error: any = await users()
      .create({ email: 'a@x.io' })
      .then(
        (): unknown => null,
        (e: unknown): unknown => e
      )
    expect(error.name).toBe('Conflict')
    expect(error.code).toBe(409)
    expect(error[ERROR].code).toBe('23505')
    expect(JSON.stringify(error)).not.toContain('23505')
  })

  it('maps invalid input syntax (class 22) to BadRequest', async () => {
    await expect(users().get('not-a-number')).rejects.toMatchObject({ name: 'BadRequest' })
  })

  it('maps an undefined column in create data to Unprocessable', async () => {
    await expect(users().create({ email: 'z@x.io', nope: 1 } as any)).rejects.toMatchObject({
      name: 'Unprocessable'
    })
  })

  it('maps a not-null violation to BadRequest', async () => {
    const people = new KyselyService<Database, 'people'>({ db, table: 'people', columns: ['id', 'name'] })
    await expect(people.create({ name: null } as any)).rejects.toMatchObject({ name: 'BadRequest' })
  })

  it('passes NotFound and MethodNotAllowed through unchanged', async () => {
    await expect(users().get(9999)).rejects.toMatchObject({
      name: 'NotFound',
      message: "No record found for id '9999'"
    })

    const single = new KyselyService<Database, 'users'>({ db, table: 'users', columns: ['id'] })
    await expect(single.remove(null)).rejects.toMatchObject({ name: 'MethodNotAllowed' })
  })
})

describe('constructor', () => {
  it('throws without db, table or columns', () => {
    expect(() => new KyselyService({ table: 'users', columns: [] } as any)).toThrow(
      'You must provide a Kysely instance as db'
    )
    expect(() => new KyselyService({ db, columns: [] } as any)).toThrow('No table name specified.')
    expect(() => new KyselyService({ db, table: 'users' } as any)).toThrow('You must provide a columns list')
  })
})

describe('review fixes', () => {
  const find = (query: any) => users().find({ paginate: false, query })
  const single = () =>
    new KyselyService<Database, 'users'>({ db, table: 'users', columns: ['id', 'name', 'age'] })
  const rowCount = async () => (await db.selectFrom('users').selectAll().execute()).length

  describe('null operands (M1)', () => {
    for (const operator of ['$gt', '$gte', '$lt', '$lte', '$like', '$ilike', '$notlike']) {
      it(`${operator}: null throws BadRequest naming the operator and column`, async () => {
        const column = operator.includes('like') ? 'name' : 'age'
        const error: any = await find({ [column]: { [operator]: null } }).then(
          (): unknown => null,
          (e: unknown): unknown => e
        )
        expect(error?.name).toBe('BadRequest')
        expect(error.message).toContain(operator)
        expect(error.message).toContain(column)
      })
    }

    it('keeps equality null and $ne: null', async () => {
      expect(await find({ age: null })).toHaveLength(1)
      expect(await find({ age: { $ne: null } })).toHaveLength(2)
    })
  })

  describe('empty conditions (M2)', () => {
    const cases: [string, unknown][] = [
      ['{ age: {} }', { age: {} }],
      ['{ $or: [{}] }', { $or: [{}] }],
      ['{ $or: [{ age: {} }] }', { $or: [{ age: {} }] }],
      ['{ $or: [] }', { $or: [] }],
      ['{ $and: [] }', { $and: [] }]
    ]

    for (const [label, query] of cases) {
      it(`${label} throws BadRequest`, async () => {
        await expect(find(query)).rejects.toMatchObject({ name: 'BadRequest' })
      })
    }
  })

  it('creates N rows for N empty objects (M3)', async () => {
    const created = await users().create([{}, {}, {}] as any)
    expect(created).toHaveLength(3)
    expect(await rowCount()).toBe(6)
    expect(new Set(created.map((row: { id: number }) => row.id)).size).toBe(3)
  })

  describe('undefined id (S1)', () => {
    it('remove(undefined) is rejected like remove(null) without multi', async () => {
      await expect(single().remove(undefined as any)).rejects.toMatchObject({ name: 'MethodNotAllowed' })
      expect(await rowCount()).toBe(3)
    })

    it('patch(undefined) is rejected like patch(null) without multi', async () => {
      await expect(single().patch(undefined as any, { age: 1 })).rejects.toMatchObject({
        name: 'MethodNotAllowed'
      })
      expect((await find({ age: 1 })).length).toBe(0)
    })

    it('get(undefined) and update(undefined) throw BadRequest', async () => {
      await expect(single().get(undefined as any)).rejects.toMatchObject({ name: 'BadRequest' })
      await expect(single().update(undefined as any, { name: 'x', age: 1 })).rejects.toMatchObject({
        name: 'BadRequest'
      })
      expect((await find({ name: 'x' })).length).toBe(0)
    })
  })

  describe('unhandled $ keys (S2)', () => {
    it('rejects an unknown $ key in a query', async () => {
      await expect(find({ $x: 1 })).rejects.toMatchObject({ name: 'BadRequest' })
    })

    it('throws at construction for an operators entry the adapter cannot translate', () => {
      expect(
        () => new KyselyService<Database, 'users'>({ db, table: 'users', columns: ['id'], operators: ['$x'] })
      ).toThrow('$x')
    })

    it('throws at construction for a filters key the adapter does not consume', () => {
      expect(
        () =>
          new KyselyService<Database, 'users'>({
            db,
            table: 'users',
            columns: ['id'],
            filters: { $x: (value) => value }
          })
      ).toThrow('$x')
    })
  })

  it('throws BadRequest for null inside $in and $nin (S3)', async () => {
    await expect(find({ age: { $in: [19, null] } })).rejects.toMatchObject({ name: 'BadRequest' })
    await expect(find({ age: { $nin: [null] } })).rejects.toMatchObject({ name: 'BadRequest' })
  })
})
