// Serves smoke/worker.ts with `wrangler dev --local`, runs the smoke sequence over HTTP, and
// stops wrangler by its captured pid. Exits 0 on success.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runSmoke } from './sequence.mjs'

const PORT = Number(process.env.SMOKE_PORT || 8799)
const base = `http://127.0.0.1:${PORT}`
const dir = fileURLToPath(new URL('.', import.meta.url))
// A listener already on the port would make the smoke test hit some other server.
if (
  await fetch(base).then(
    () => true,
    () => false
  )
) {
  console.error(`port ${PORT} is already in use; set SMOKE_PORT`)
  process.exit(1)
}

const wrangler = spawn(
  'wrangler',
  ['dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1', '--config', 'wrangler.toml'],
  {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }
  }
)
let output = ''

wrangler.stdout.on('data', (d) => (output += d))
wrangler.stderr.on('data', (d) => (output += d))

// Stops the process group wrangler started (workerd is a child of it), by the captured pid.
const stop = () => {
  try {
    process.kill(-wrangler.pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

let exitCode = 1

try {
  let up = false

  for (let i = 0; i < 120 && !up; i++) {
    if (wrangler.exitCode !== null) {
      throw new Error(`wrangler exited with ${wrangler.exitCode}\n${output.slice(-2000)}`)
    }

    try {
      await fetch(base)
      up = true
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  if (!up) {
    throw new Error(`wrangler did not start\n${output.slice(-2000)}`)
  }

  console.log(
    output.split('\n').find((line) => line.includes('Ready on')) ?? 'wrangler output: no Ready line'
  )
  console.log(
    `auth smoke ${await runSmoke((path, init) => fetch(base + path, init))} on workers (wrangler dev --local)`
  )
  exitCode = 0
} catch (error) {
  console.error(error)
} finally {
  stop()
}

process.exit(exitCode)
