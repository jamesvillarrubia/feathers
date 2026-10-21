import { describe, it, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import assert from 'assert'
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { generate, getContext } from './index.js'

const PORT = 30301

async function waitForServer(port: number, retries = 20, interval = 500): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(`http://localhost:${port}`)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
  }
  throw new Error(`Server did not start on port ${port}`)
}

function killProcess(proc: ChildProcess) {
  if (!proc.killed) {
    proc.kill()
  }
}

describe('create-feathers', () => {
  let tmpDir: string
  let serverProcess: ChildProcess | undefined

  afterEach(async () => {
    if (serverProcess) {
      killProcess(serverProcess)
      serverProcess = undefined
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('generates a Node app that starts without errors', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'feathers-test-'))

    const ctx = getContext({
      cwd: tmpDir,
      name: 'test-app',
      description: 'A test app',
      platform: 'node' as const,
      packager: 'npm' as const,
      sse: true
    } as any)

    await generate(ctx as any)

    // The generated app imports `feathers/authentication`, which the published pre-release
    // lacks. Point the installed `feathers` at this workspace's compiled package.
    const nodeModules = join(tmpDir, 'node_modules')
    await rm(join(nodeModules, 'feathers'), { recursive: true, force: true })
    await symlink(
      fileURLToPath(new URL('../../feathers', import.meta.url)),
      join(nodeModules, 'feathers'),
      'dir'
    )

    const hook = await readFile(join(tmpDir, 'src', 'hooks', 'authenticate.ts'), 'utf8')
    const env = await readFile(join(tmpDir, '.env'), 'utf8')
    const apiKey = /^API_KEY=(.+)$/m.exec(env)![1]

    const readme = await readFile(join(tmpDir, 'README.md'), 'utf8')

    assert.ok(
      readme.indexOf('source .env') !== -1 && readme.indexOf('source .env') < readme.indexOf('$API_KEY'),
      'the README loads .env before the curl example reads $API_KEY'
    )
    assert.ok(!hook.includes('supersecret'), 'the hook has no hardcoded key')
    assert.ok(hook.includes("authenticate('jwt', 'api-key')"), 'the hook calls authenticate(jwt, api-key)')

    // Start the server as a child process
    const isWindows = process.platform === 'win32'
    serverProcess = spawn(isWindows ? 'npm.cmd' : 'npm', ['start'], {
      cwd: tmpDir,
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'pipe'
    })

    // Collect stderr for error reporting
    let stderr = ''
    serverProcess.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    // Fail if the process exits before we can connect
    const exitPromise = new Promise<never>((_, reject) => {
      serverProcess!.on('exit', (code) => {
        reject(new Error(`Server exited with code ${code} before responding.\nstderr: ${stderr}`))
      })
    })

    // Wait for the server to be ready
    await Promise.race([waitForServer(PORT), exitPromise])

    const url = `http://localhost:${PORT}/messages`
    const ok = await fetch(url, { headers: { 'x-api-key': apiKey } })
    const wrong = await fetch(url, { headers: { 'x-api-key': 'supersecret' } })
    const missing = await fetch(url)

    assert.ok(ok.ok, `Server responded with status ${ok.status}`)
    assert.strictEqual(wrong.status, 401)
    assert.strictEqual(missing.status, 401)
  }, 120000)
})
