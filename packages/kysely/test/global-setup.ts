import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { assertTestDatabase } from './guard.js'

const composeFile = fileURLToPath(new URL('./docker-compose.yml', import.meta.url))

const docker = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  execFileSync('docker', args, { encoding: 'utf8', env }).trim()

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/**
 * Runs once before any test file. Without DATABASE_URL (CI supplies one through
 * a Postgres service container), it requires the `orbstack` docker context,
 * starts postgres:16 from docker-compose.yml on a free port, and stops that
 * container by its captured id afterwards.
 */
export default async function setup() {
  if (process.env.DATABASE_URL) {
    assertTestDatabase(process.env.DATABASE_URL)

    return undefined
  }

  let context = ''

  try {
    context = docker(['context', 'show'])
  } catch (error) {
    throw new Error(`Could not run \`docker context show\`: ${(error as Error).message}`)
  }

  if (context !== 'orbstack') {
    throw new Error(
      `docker context is '${context}', expected 'orbstack'. Run \`docker context use orbstack\` (never start Docker Desktop), or set DATABASE_URL.`
    )
  }

  const port = await freePort()
  const project = `kysely-adapter-test-${process.pid}`
  const env = { ...process.env, KYSELY_TEST_PG_PORT: String(port) }
  const compose = (args: string[]) => docker(['compose', '-p', project, '-f', composeFile, ...args], env)

  compose(['up', '-d', '--wait'])

  const containerId = compose(['ps', '-q', 'postgres'])

  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/feathers_kysely_test`

  return () => {
    docker(['rm', '-f', containerId])
    compose(['down', '--volumes'])
  }
}
