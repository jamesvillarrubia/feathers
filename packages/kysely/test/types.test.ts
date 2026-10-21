import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = (name: string) => fileURLToPath(new URL(`./types/fixtures/${name}.ts`, import.meta.url))

// Compile a fixture on its own with the package's tsc and the repo compiler options.
function tsc(file: string) {
  const result = spawnSync(
    'npx',
    [
      'tsc',
      '--noEmit',
      '--ignoreConfig',
      '--strict',
      '--strictNullChecks',
      'true',
      '--target',
      'ES2020',
      '--module',
      'ESNext',
      '--moduleResolution',
      'bundler',
      '--skipLibCheck',
      '--types',
      'node',
      file
    ],
    { cwd: root, encoding: 'utf8' }
  )

  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('compile-time guarantees', () => {
  it('compiles a service with columns, a Selectable get() and an Insertable create()', () => {
    const { status, output } = tsc(fixture('valid'))
    expect(output).toBe('')
    expect(status).toBe(0)
  })

  it('fails to compile new KyselyService({ db, table }) without columns', () => {
    const { status, output } = tsc(fixture('missing-columns'))
    expect(status).not.toBe(0)
    expect(output).toContain('missing-columns.ts')
    expect(output).toMatch(/columns/)
  })

  it("fails to compile columns: ['nope'] for a table without that column", () => {
    const { status, output } = tsc(fixture('unknown-column'))
    expect(status).not.toBe(0)
    expect(output).toContain('unknown-column.ts')
    expect(output).toMatch(/nope/)
  })

  it('fails to compile create() with a field missing from Insertable', () => {
    const { status, output } = tsc(fixture('create-missing-field'))
    expect(status).not.toBe(0)
    expect(output).toContain('create-missing-field.ts')
    expect(output).toMatch(/email/)
  })
})
