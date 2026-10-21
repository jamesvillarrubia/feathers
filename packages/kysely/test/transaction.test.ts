import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { feathers } from 'feathers'
import { KyselyService, transaction, withTransaction } from '../src/index.js'
import { createDb, createTables, dropTables, truncate } from './helpers.js'
import type { Database } from './helpers.js'

const db = createDb()
const app = feathers<{ users: KyselyService<Database, 'users'> }>()

app.use(
  'users',
  new KyselyService<Database, 'users'>({
    db,
    table: 'users',
    columns: ['id', 'email', 'name', 'age'],
    multi: true
  })
)

app.service('users').hooks({
  around: { all: [transaction(db)] }
})

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
})

describe('withTransaction', () => {
  it('rolls back a service create when the callback throws', async () => {
    await expect(
      withTransaction(app, db, async (trx) => {
        await users().create({ email: 'rollback@x.io' }, { transaction: trx })
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    const rows = await users().find({ paginate: false, query: { email: 'rollback@x.io' } })
    expect(rows).toEqual([])
  })

  it('commits when the callback resolves and returns its value', async () => {
    const created = await withTransaction(app, db, (trx) =>
      users().create({ email: 'commit@x.io' }, { transaction: trx })
    )

    expect(created.email).toBe('commit@x.io')

    const rows = await users().find({ paginate: false, query: { email: 'commit@x.io' } })
    expect(rows).toHaveLength(1)
  })

  it('shows uncommitted rows to the same transaction only', async () => {
    await withTransaction(app, db, async (trx) => {
      await users().create({ email: 'inside@x.io' }, { transaction: trx })

      const inside = await users().find({ paginate: false, transaction: trx })
      const outside = await db.selectFrom('users').selectAll().execute()

      expect(inside).toHaveLength(1)
      expect(outside).toHaveLength(0)
    })
  })
})

describe('transaction around hook', () => {
  it('rolls back every write of a failing multi-row call', async () => {
    await expect(users().create([{ email: 'dup@x.io' }, { email: 'dup@x.io' }], {})).rejects.toMatchObject({
      name: 'Conflict'
    })

    expect(await db.selectFrom('users').selectAll().execute()).toHaveLength(0)
  })

  it('joins an existing transaction instead of opening a nested one', async () => {
    await expect(
      withTransaction(app, db, async (trx) => {
        // The hook sees params.transaction and calls next() without opening a second one.
        await users().create({ email: 'outer@x.io' }, { transaction: trx })
        await users().create({ email: 'inner@x.io' }, { transaction: trx })
        throw new Error('rollback both')
      })
    ).rejects.toThrow('rollback both')

    expect(await db.selectFrom('users').selectAll().execute()).toHaveLength(0)
  })

  it('exposes params.transaction to the service call when it opens one', async () => {
    let seen: unknown
    const app2 = feathers<{ users: KyselyService<Database, 'users'> }>()

    app2.use(
      'users',
      new KyselyService<Database, 'users'>({ db, table: 'users', columns: ['id', 'email', 'name', 'age'] })
    )
    app2.service('users').hooks({
      around: {
        all: [
          transaction(db),
          async (context: any, next: any) => {
            seen = context.params.transaction
            await next()
          }
        ]
      }
    })

    await app2.service('users').create({ email: 'hook@x.io' })

    expect(seen).toBeDefined()
    expect(await db.selectFrom('users').selectAll().execute()).toHaveLength(1)
  })

  it('the transaction the hook sets is the one the query runs in', async () => {
    const app3 = feathers<{ users: KyselyService<Database, 'users'> }>()
    let inside = -1
    let outside = -1

    app3.use(
      'users',
      new KyselyService<Database, 'users'>({ db, table: 'users', columns: ['id', 'email', 'name', 'age'] })
    )
    app3.service('users').hooks({
      around: {
        create: [
          transaction(db),
          async (context: any, next: any) => {
            await next()
            const trx = context.params.transaction
            expect(trx.isTransaction).toBe(true)
            inside = (await trx.selectFrom('users').selectAll().execute()).length
            outside = (await db.selectFrom('users').selectAll().execute()).length
          }
        ]
      }
    })

    await app3.service('users').create({ email: 'visible@x.io' })

    expect(inside).toBe(1)
    expect(outside).toBe(0)
  })

  it('rolls back writes to two services that share params.transaction when the hook throws', async () => {
    const app4 = feathers<{
      users: KyselyService<Database, 'users'>
      people: KyselyService<Database, 'people'>
    }>()

    app4.use(
      'users',
      new KyselyService<Database, 'users'>({ db, table: 'users', columns: ['id', 'email', 'name', 'age'] })
    )
    app4.use(
      'people',
      new KyselyService<Database, 'people'>({ db, table: 'people', columns: ['id', 'name'] })
    )
    app4.service('users').hooks({
      around: {
        create: [
          transaction(db),
          async (context: any, next: any) => {
            await next()
            await app4.service('people').create({ name: 'Zed' }, { transaction: context.params.transaction })
            throw new Error('abort both')
          }
        ]
      }
    })

    await expect(app4.service('users').create({ email: 'a@x.io' })).rejects.toThrow('abort both')

    expect(await db.selectFrom('users').selectAll().execute()).toHaveLength(0)
    expect(await db.selectFrom('people').selectAll().execute()).toHaveLength(0)
  })
})
