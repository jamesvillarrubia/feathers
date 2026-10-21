import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { feathers } from 'feathers'
import { KyselyService } from '../src/index.js'
import { createDb, createTables, dropTables, truncate } from './helpers.js'
import type { Database } from './helpers.js'

const db = createDb()
const app = feathers<{ users: KyselyService<Database, 'users'> }>()

app.use(
  'users',
  new KyselyService<Database, 'users'>({
    db,
    table: 'users',
    columns: ['id', 'email', 'name', 'age']
  })
)

const users = () => app.service('users')

beforeAll(async () => {
  await createTables(db)
})

afterAll(async () => {
  await dropTables(db)
  await db.destroy()
})

beforeEach(async () => {
  await truncate(db)
  await users().create({ email: 'a@x.io', name: 'Ann', age: 41 })
})

describe('update is full-row only', () => {
  it('throws BadRequest naming age when the payload omits it and leaves the row unchanged', async () => {
    await expect(users().update(1, { name: 'x' })).rejects.toMatchObject({
      name: 'BadRequest',
      message: expect.stringContaining('age')
    })

    const row = await users().get(1)
    expect(row.age).toBe(41)
    expect(row.name).toBe('Ann')
  })

  it('names every missing column', async () => {
    await expect(users().update(1, { email: 'b@x.io' })).rejects.toMatchObject({
      name: 'BadRequest',
      message: expect.stringMatching(/name.*age|age.*name/)
    })
  })

  it('treats an undefined value as omitted', async () => {
    await expect(users().update(1, { email: 'b@x.io', name: 'B', age: undefined })).rejects.toMatchObject({
      name: 'BadRequest'
    })
  })

  it('returns the replaced row and writes null as NULL', async () => {
    const result = await users().update(1, { email: 'b@x.io', name: null, age: 7 })

    expect(result).toEqual({ id: 1, email: 'b@x.io', name: null, age: 7 })

    const raw = await db.selectFrom('users').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()
    expect(raw.name).toBeNull()
    expect(raw.age).toBe(7)
  })

  it('throws BadRequest for a null id and for array data', async () => {
    await expect(users().update(null as any, { email: 'b', name: 'b', age: 1 })).rejects.toMatchObject({
      name: 'BadRequest'
    })
    await expect(users().update(1, [] as any)).rejects.toMatchObject({ name: 'BadRequest' })
  })
})
