import { Kysely } from 'kysely'
import type { Generated, Selectable } from 'kysely'

export interface UsersTable {
  id: Generated<number>
  email: string
  name: string | null
  age: number | null
}

export interface DB {
  users: UsersTable
}

export type User = Selectable<UsersTable>

export declare const db: Kysely<DB>
