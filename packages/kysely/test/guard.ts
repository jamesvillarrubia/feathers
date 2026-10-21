/** Refuses a DATABASE_URL that does not point at a throwaway database. The tests truncate and drop tables. */
export function assertTestDatabase(url: string): void {
  let name: string

  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  } catch {
    throw new Error('DATABASE_URL is not a valid URL; refusing to run tests that drop tables')
  }

  if (!name.includes('test')) {
    throw new Error(
      `DATABASE_URL points at database '${name}'. The tests truncate and drop the people and users tables, so the database name must contain "test". Refusing to run.`
    )
  }
}
