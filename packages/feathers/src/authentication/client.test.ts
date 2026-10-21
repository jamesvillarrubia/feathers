import { describe, it, expect, vi } from 'vitest'
import { feathers } from '../index.js'
import { fetchClient } from '../client/index.js'
import { NotAuthenticated } from '../errors.js'
import { createAuthApp, SECRET } from '../../fixtures/authentication.js'
import { authenticationClient } from './client.js'
import { signJwt } from './jwt.js'

const now = () => Math.floor(Date.now() / 1000)

describe('authentication client', () => {
  // 20
  it('reAuthenticate with an expired stored token rejects without a request to /authentication', async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (url: any) => {
      calls.push(String(url))
      return new Response('{}')
    })
    const client: any = feathers<any>().configure(
      fetchClient(fetcher as any, { baseUrl: 'http://localhost' })
    )
    const storage = new Map<string, string>()
    const expired = await signJwt({ sub: '1', iss: 'feathers', exp: now() - 10 }, SECRET)

    storage.set('feathers-jwt', expired)
    client.configure(
      authenticationClient({
        storage: {
          getItem: (k: string) => storage.get(k) ?? null,
          setItem: (k: string, v: string) => void storage.set(k, v),
          removeItem: (k: string) => void storage.delete(k)
        }
      })
    )

    await expect(client.reAuthenticate()).rejects.toBeInstanceOf(NotAuthenticated)
    expect(calls.filter((u) => u.includes('/authentication')).length).toBe(0)
  })

  it('authenticates, sends Bearer on later requests, reAuthenticates, and logs out', async () => {
    const server = await createAuthApp()

    await server.app.service('users').create({ email: 'a@example.com', password: 'secret' })

    const client: any = feathers<any>().configure(
      fetchClient((url: any, init: any) => server.handler(new Request(url, init)) as any, {
        baseUrl: 'http://localhost'
      })
    )

    client.configure(authenticationClient())

    await expect(client.service('messages').find()).rejects.toMatchObject({ code: 401 })

    const result = await client.authenticate({
      strategy: 'local',
      email: 'a@example.com',
      password: 'secret'
    })

    expect(typeof result.accessToken).toBe('string')
    expect(await client.service('messages').find()).toEqual([{ text: 'hello' }])
    await expect(client.reAuthenticate()).resolves.toBeTruthy()
    await client.logout()
    await expect(client.service('messages').find()).rejects.toMatchObject({ code: 401 })
    await expect(client.reAuthenticate()).rejects.toBeInstanceOf(NotAuthenticated)
  })
})
