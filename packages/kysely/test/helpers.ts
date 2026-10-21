import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Generated } from 'kysely'
import pg from 'pg'
import { assertTestDatabase } from './guard.js'

export interface PeopleTable {
  id: Generated<number>
  name: string
  age: number | null
  created: boolean | null
}

export interface UsersTable {
  id: Generated<number>
  email: string | null
  name: string | null
  age: number | null
}

export interface Database {
  people: PeopleTable
  users: UsersTable
}

export function createDb() {
  const connectionString = process.env.DATABASE_URL

  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (test/global-setup.ts sets it)')
  }

  assertTestDatabase(connectionString)

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) })
  })
}

export async function createTables(db: Kysely<Database>) {
  await sql`drop table if exists people, users`.execute(db)
  await db.schema
    .createTable('people')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('age', 'integer')
    .addColumn('created', 'boolean')
    .execute()
  await db.schema
    .createTable('users')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('email', 'text', (col) => col.unique())
    .addColumn('name', 'text')
    .addColumn('age', 'integer')
    .execute()
}

export async function dropTables(db: Kysely<Database>) {
  await sql`drop table if exists people, users`.execute(db)
}

export async function truncate(db: Kysely<Database>) {
  await sql`truncate people, users restart identity`.execute(db)
}
