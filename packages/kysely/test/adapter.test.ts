import { afterAll, beforeAll, beforeEach } from 'vitest'
import { feathers } from 'feathers'
import { errors } from 'feathers/errors'
import adapterTests, { allTestNames } from 'adapter-tests'
import { KyselyService } from '../src/index.js'
import { createDb, createTables, dropTables, truncate } from './helpers.js'
import type { Database } from './helpers.js'

const db = createDb()
const app = feathers()
const people = new KyselyService<Database, 'people'>({
  db,
  table: 'people',
  columns: ['id', 'name', 'age', 'created'],
  events: ['testing']
})

app.use('people', people)

beforeAll(async () => {
  await createTables(db)
})

afterAll(async () => {
  await dropTables(db)
  await db.destroy()
})

beforeEach(async () => {
  await truncate(db)
  // The shared suite mutates service.options between tests.
  people.options.multi = false
  people.options.paginate = false
})

adapterTests(allTestNames)(app, errors, 'people', 'id')
