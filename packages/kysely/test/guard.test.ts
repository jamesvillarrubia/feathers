import { describe, expect, it } from 'vitest'
import { assertTestDatabase } from './guard.js'

describe('assertTestDatabase', () => {
  it('rejects a DATABASE_URL whose database name lacks "test"', () => {
    expect(() => assertTestDatabase('postgres://u:p@localhost:5432/prod_app')).toThrow(/"test"/)
    expect(() => assertTestDatabase('postgres://u:p@localhost:5432/feathers_kysely')).toThrow(
      /feathers_kysely/
    )
  })

  it('accepts a database name containing "test"', () => {
    expect(() => assertTestDatabase('postgres://u:p@localhost:5432/feathers_kysely_test')).not.toThrow()
  })

  it('rejects an unparseable URL', () => {
    expect(() => assertTestDatabase('not a url')).toThrow(/DATABASE_URL/)
  })
})
