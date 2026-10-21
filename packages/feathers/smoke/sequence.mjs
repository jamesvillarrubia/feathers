// Runtime-neutral authentication smoke sequence: login, protected route, no token, API key.
// `call(path, init)` returns a web-standard Response (a createHandler call or a real fetch).

export const SMOKE_USER = { email: 'smoke@example.com', password: 'smoke-password' }
export const SMOKE_API_KEY = 'smoke-api-key-0123456789'

function check(condition, message) {
  if (!condition) {
    throw new Error(`auth smoke failed: ${message}`)
  }
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

export async function runSmoke(call) {
  const login = await call('/authentication', json({ strategy: 'local', ...SMOKE_USER }))
  const body = await login.json()

  check(login.status === 201, `login returned ${login.status}`)
  check(typeof body.accessToken === 'string', 'login returned no accessToken')
  check(!JSON.stringify(body).includes('password'), 'login body contains a password key')

  const protectedOk = await call('/messages', { headers: { authorization: `Bearer ${body.accessToken}` } })

  check(protectedOk.status === 200, `protected route with token returned ${protectedOk.status}`)

  const noToken = await call('/messages')

  check(noToken.status === 401, `protected route without token returned ${noToken.status}`)

  const wrong = await call('/authentication', json({ strategy: 'local', ...SMOKE_USER, password: 'nope' }))

  check(wrong.status === 401, `wrong password returned ${wrong.status}`)

  const apiKeyOk = await call('/reports', { headers: { 'x-api-key': SMOKE_API_KEY } })
  const apiKeyBad = await call('/reports', { headers: { 'x-api-key': 'wrong' } })

  check(apiKeyOk.status === 200, `api key returned ${apiKeyOk.status}`)
  check(apiKeyBad.status === 401, `wrong api key returned ${apiKeyBad.status}`)

  return 'ok'
}
