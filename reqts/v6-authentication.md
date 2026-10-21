# Authentication for Feathers v6

Feathers v6 has no way to log a user in and check a token on later requests, so this spec adds a JWT and email/password login that runs on Node, Deno, Bun, and Cloudflare Workers.

Status: approved for build 2026-10-20. Branch `feature/v6-hooks-all-methods`.

## Problem

The v6 package `feathers` has no authentication code. The only v6 artifact is the scaffold hook in [authenticate.tpl.ts](/Users/james/Sites/prs/feathers-v6/packages/create-feathers/src/templates/authenticate.tpl.ts), which reads `x-api-key` from `params.request.headers` (lines 10-11) and compares it to the literal `'supersecret'` (line 13).

v5 on the `dove` branch had `packages/authentication`, `authentication-local`, `authentication-oauth`, and `authentication-client`. Those packages depend on Node-only code: `jsonwebtoken` (`packages/authentication/package.json`), `bcryptjs` (`packages/authentication-local/package.json`), `IncomingMessage` in `JWTStrategy.parse` (`jwt.ts:165`), and `process.nextTick` (`jwt.ts:68`). They do not run on Workers or on web-standard `Request` objects.

v6 `packages/feathers/package.json` has no `dependencies` key (verified: `grep -c '"dependencies"'` returns 0). Any authentication code in core has to keep that true.

## Current v6 and v5 code

- `createHandler` builds `params` with `provider: 'rest'`, `request`, `headers`, `route` at [http/index.ts:158-164](/Users/james/Sites/prs/feathers-v6/packages/feathers/src/http/index.ts:158). `headers` is `params.headers` or `Object.fromEntries(request.headers)` (line 103). A hook can read `params.headers.authorization` without a handler change.
- `authorization` is already in `CORS_HEADERS` (line 32).
- `externalMethods` defaults to `methods` ([service.ts:65](/Users/james/Sites/prs/feathers-v6/packages/feathers/src/service.ts:65)). The handler rejects a method outside `getExternalMethods` with `MethodNotAllowed` (http/index.ts:146-151). This branch runs hooks on all methods, so a hook on a non-external method still runs for internal calls.
- `SseService.find(connection)` receives the hooked params object as `connection` ([sse.service.ts:14](/Users/james/Sites/prs/feathers-v6/packages/feathers/src/http/sse.service.ts:14)). It matches publishes with `channel.connections.includes(connection)` (line 26) and calls `channel.dataFor(connection)` (line 27). Fields that a hook sets on `params` (such as `user`) are therefore visible to publishers and `dataFor`.
- The v6 client opens the stream through `fetch` and reads `res.body.getReader()` ([client/fetch.ts:109-131](/Users/james/Sites/prs/feathers-v6/packages/feathers/src/client/fetch.ts:109)). It merges `params.headers` into the request ([client/fetch.ts:72-76](/Users/james/Sites/prs/feathers-v6/packages/feathers/src/client/fetch.ts:72)). `grep -rn EventSource packages/feathers/src` finds nothing. The Feathers client can therefore send an `Authorization` header on the SSE request.
- v5 design to carry over: `AuthenticationService.create` runs strategies, builds a JWT, and returns `{ accessToken, authentication: { payload }, user }` (`service.ts:110-142`). `JWTStrategy.authenticate` verifies the token, then loads the entity by `payload.sub` (`jwt.ts:134-163`). The `authenticate` hook calls `authService.authenticate(params.authentication, ...)`, merges the result into `params`, and sets `params.authenticated = true` (`hooks/authenticate.ts:45-61`). Internal calls with no `provider` and no `authentication` pass (line 63-67). `LocalStrategy` hashes with `bcrypt.hash(password, 10)` and answers every failure with `'Invalid login'` (`strategy.ts:27-31, 118-119`). v5 default JWT options are HS256, issuer `feathers`, `expiresIn: '1d'` (`options.ts:3-12`).
- v5 channels read `connection[entity]` and removed it on logout or token expiry with a timer (`jwt.ts:63-77`).
- `NotAuthenticated` (401) exists in [errors.ts:74](/Users/james/Sites/prs/feathers-v6/packages/feathers/src/errors.ts:74).
- No `protect` hook and no in-memory service exist in v6 (verified: `grep -rniE "protect\(|class MemoryService|adapter-memory"` over `packages/*.ts` returns no file).

Runtime facts not verified in this session (check before build): Web Crypto `HMAC` and `PBKDF2` are available in Node 22, Deno, Bun, and Workers; Workers caps PBKDF2 iterations (recalled as 100,000); Web Crypto has no scrypt or Argon2.

## Scope tiers

| Tier | Contents | Recommendation |
|---|---|---|
| 1 | Authentication service, JWT strategy (HS256), local strategy (email/password) with a pluggable `hasher` and rehash on login, `api-key` strategy, `authenticate` hook, client token handling, SSE auth through the `Authorization` header only. No refresh tokens: clients log in again on expiry | Build first |
| 2 | RS256/ES256 and JWKS verification, refresh strategy, single-use SSE ticket for native `EventSource` | After tier 1 ships |
| 3 | OAuth (authorization-code flow, provider profiles) | Separate package, later |

Recommendation: ship tier 1 only. Tier 1 covers the `api-key` strategy that replaces the scaffold's API-key hook and the login flow every v5 app used. OAuth needs redirects, session state, and provider-specific profiles, which belong in their own package with their own dependencies.

## Dependency choice

Option A: core subpath `feathers/authentication`, zero dependencies, built on Web Crypto.
Option B: separate package (`@feathersjs/authentication`) depending on `jose` for JWT.
Option C: core subpath plus an optional `jose`-backed verifier loaded only when configured.

Recommendation: Option A.

- Web Crypto `HMAC-SHA256` signs and verifies HS256 tokens in about 80 lines (base64url, JSON, `crypto.subtle.sign` and `verify`).
- The exports map of `packages/feathers/package.json` already holds subpaths (`./hooks`, `./errors`, `./client`, `./http`), so `./authentication` and `./authentication/client` follow the existing shape.
- `crypto.subtle.verify` for HMAC compares in constant time.
- PBKDF2-SHA256 from Web Crypto hashes passwords on all four runtimes with no native module.
- Cost: core now owns security-sensitive code. Mitigation: test vectors from RFC 7515/7519 and a cross-check test that verifies tokens with `jose` as a devDependency only.
- Option B keeps core small but forces every app to install two packages and pulls a runtime dependency into the default login path. Revisit if tier 2 needs JWKS (`jose` handles it).

## API contract

### Config

```ts
interface AuthenticationConfig {
  secret: string            // at least 32 bytes; setup() throws otherwise
  entity: string | null     // default 'user'; null disables entity loading
  service: string           // users service path, e.g. 'users'
  entityId?: string         // defaults to the service's id option
  authStrategies: string[]  // strategies allowed to create a token, e.g. ['jwt', 'local']; 'api-key' is rejected here
  jwt: {
    algorithm: 'HS256'      // only value in tier 1
    expiresIn: number       // seconds, default 86400; a local login sets exp = auth_time + expiresIn, and a token minted from the jwt strategy keeps the presented token's exp, so expiry ends the session
    issuer: string          // default 'feathers'
    audience?: string
  }
  local?: {
    usernameField: string   // default 'email'
    passwordField: string   // default 'password'
    iterations: number      // PBKDF2, default 600000
    hasher?: PasswordHasher // tier 1; defaults to the PBKDF2 hasher
  }
  apiKey?: {                // tier 1; set exactly one of keys or verify
    header: string          // default 'x-api-key'
    keys?: string[]         // static key list
    verify?: (key: string, params: Params) => Promise<Record<string, unknown> | null>
  }
}

interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(password: string, hash: string): Promise<boolean>
  needsRehash(hash: string): boolean // true when the stored hash should be replaced by the default hasher's format
}
```

Core ships no bcrypt code. A v5 app migrates by passing a `hasher` that verifies bcrypt hashes (see Security behaviors). `pbkdf2Hasher.needsRehash` returns true for a hash whose prefix is not `pbkdf2-sha256$` or whose stored iteration count is below `local.iterations`. The bcrypt-verify `hasher` returns true from `needsRehash` for `$2a$/$2b$` hashes.

`setup()` throws when `apiKey` sets both `keys` and `verify`, or neither. `setup()` also throws when `authStrategies` contains `'api-key'`, because an API key authenticates each request and never mints a token.

### Service

`AuthenticationService` is a normal service registered at `/authentication`.

- `create(data: { strategy: string, ... })` runs the named strategy. It returns `{ accessToken, authentication: { strategy, payload }, user }`.
- `remove(null | accessToken)` verifies the token and returns the result. Tokens are stateless, so logout is a client action (matches v5 `service.ts:151-163`).
- `authenticate(request, params, ...strategies)` is an internal method used by the hook. It is not in `externalMethods`.
- `setup()` throws when `secret` is shorter than 32 bytes, when `service` is missing for a non-null `entity`, or when the users service does not exist.

### Strategy interface

```ts
interface AuthenticationStrategy {
  name: string
  authenticate(request: AuthenticationRequest, params: Params): Promise<AuthenticationResult>
  parse?(request: Request): Promise<AuthenticationRequest | null> // header parsing
}
```

`parse` takes a web-standard `Request`, replacing v5's `IncomingMessage` (`jwt.ts:165`).

Tier 1 registers three strategies: `jwt`, `local`, and `api-key`. All three run through `authenticate()`.

`api-key` behavior:
- Its `parse` reads `apiKey.header` (default `x-api-key`) and returns `{ strategy: 'api-key', apiKey }`, or null when the header is absent.
- Its `authenticate` compares the submitted key to each entry of `keys`, or calls `verify(key, params)`. A null from `verify`, or no matching key, throws `NotAuthenticated('Invalid login')`.
- A match sets `params.authenticated = true` and `params.apiKey` to the `verify` result (or `{}` for a `keys` match). It sets no `params.user`.
- The comparison hashes the submitted key and each configured key with SHA-256 (Web Crypto), then compares the digests with `timingSafeEqual`. The loop visits every configured key and every digest byte, with no early return, so neither key length nor match position changes response time.
- `AuthenticationService.create({ strategy: 'api-key' })` throws `NotAuthenticated`.
- The scaffold file `authenticate.tpl.ts` stops reading `x-api-key` against `'supersecret'` and calls `authenticate('jwt', 'api-key')`.

### Hook

```ts
import { authenticate } from 'feathers/authentication'

app.service('messages').hooks({
  around: { all: [authenticate('jwt')] }
})
```

Behavior:
- It is an `around` hook with the `(context, next)` shape used by the scaffold hook.
- When `params.authenticated === true` it calls `next()`.
- When `params.provider` is set and no credentials are present it throws `NotAuthenticated`.
- When `params.provider` is unset (internal call) it calls `next()`.
- It builds `params.authentication` from `params.headers` through the `parse` of each strategy named in the hook (`authorization: Bearer <token>` for `jwt`, `apiKey.header` for `api-key`), so REST, SSE, and tests that pass `params.headers` behave the same. The first named strategy whose `parse` returns credentials authenticates the request.
- It merges the strategy result (`user`, `authentication`) into `context.params` and sets `params.authenticated = true`. It drops the top-level `accessToken` from the merged result (as v5 does, `authenticate.ts:56`). Service params keep `params.headers.authorization` and `params.authentication.accessToken`, so a REST service can read or forward the header. The SSE service sanitizes the connection it stores: before it emits `connection` it deletes `params.request`, removes the `authorization` header and `authentication.accessToken`, and removes the password field from `connection.user`. It edits the connection in place, so `channel.connections.includes(connection)` still matches.
- It throws when used on the authentication service itself (as v5, line 39-43).

### Client

`feathers/authentication/client` exports `authenticationClient({ storage, header })`.

- `app.authenticate({ strategy, ...credentials })` calls `POST /authentication` and stores `accessToken` through `storage`.
- `app.reAuthenticate()` reads the stored token and verifies it. When the token has expired, it rejects with `NotAuthenticated`, and the app calls `app.authenticate` with credentials again. The client never requests a new token on its own.
- `app.logout()` removes the token.
- The client adds `Authorization: Bearer <token>` to `params.headers` for every request, including the SSE `find`.
- `storage` defaults to an in-memory store. A `localStorage` adapter is opt-in (v5 had `MemoryStorage` and `StorageWrapper`, `storage.ts:7, 31`).

## Token transport

- HTTP: `Authorization: Bearer <jwt>`. A bare token without the scheme is rejected.
- SSE with the Feathers client: same header, because the client streams SSE over `fetch` (see research). Tier 1 authenticates SSE only through the `Authorization` header.
- SSE with a native browser `EventSource`: the API cannot set headers, so tier 1 does not support it. An `EventSource` request to a protected SSE service gets 401, and the SSE service ignores a `?ticket=` parameter. Tier 2 adds `POST /authentication` with `{ strategy: 'sse-ticket' }`, which returns a 30-second, single-use ticket that the SSE service accepts once at `?ticket=`. Query-string access tokens are not supported, because URLs land in server and proxy logs.
- API keys: the header named by `apiKey.header` (default `x-api-key`) authenticates a request through `authenticate('api-key')`. It works on any service, including the SSE service, because the Feathers client can send the header.
- Stream lifetime: when the connection's token `exp` passes, the server ends the stream. The app logs in again to get a fresh token (tier 1 has no refresh), and the client reconnects with it (`sseClient` already reconnects with backoff, `client/sse.ts:36-52`). This replaces v5's expiration timer on the connection.
- Publishers: `authenticate('jwt')` on the SSE service `find` puts `user` on the connection params, so `app.publish` and `channel.dataFor` read `connection.user`.

## Users service and database adapters

- The users service is any service with `get(id)` and `find({ query })`. The authentication package never imports an adapter.
- `JWTStrategy` loads the entity with `usersService.get(payload.sub)`. `LocalStrategy` loads it with `usersService.find({ query: { [usernameField]: value, $limit: 1 } })`.
- Both calls omit `provider`, so users-service hooks that guard external access do not block login (same as v5, `jwt.ts:117-121`).
- `LocalStrategy` exposes `hashPassword(password)`. The users service calls it in a `create`/`patch` hook through `hashPassword('password')` exported from `feathers/authentication`. The hook skips a call whose `params.rehash` is `true`, because the rehash patch (next bullet) already carries a hash.
- Rehash on login: after a successful local login, when `hasher.needsRehash(storedHash)` returns true, `LocalStrategy` computes `pbkdf2Hasher.hash(password)` at `local.iterations` and calls `usersService.patch(id, { [passwordField]: newHash }, { rehash: true })`. The call has no `provider`, so external-access guards do not run. A failed patch is logged with the user id and does not fail the login.
- The users service must not return the hash. `feathers/authentication` exports `protect(...fields)`, an `around` hook that deletes fields from external results (v6 has none today).
- Core authentication tests use an in-memory users service defined in the test file. One integration test in `packages/kysely` runs local login against a Postgres users table. Adapter-specific tests (unique email index, hash column length 100+ characters) move into the adapter spec.

## Security behaviors

- Algorithm: the verifier accepts only the configured `alg`. A token with `alg: none` or a different `alg` is rejected.
- Claims: `exp`, `nbf`, `iss`, and `aud` (when configured) are checked on every verification. A token without `exp` is rejected.
- Signature comparison uses `crypto.subtle.verify`.
- Password hash format: `pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>`, 16-byte random salt, 32-byte derived key. The format stores its own iteration count so a later increase does not break old hashes.
- Hash format discrimination: a stored hash that starts with `$2a$` or `$2b$` is a v5 bcrypt hash. A stored hash that starts with `pbkdf2-sha256$` is the format above. The `hasher` reads the prefix to pick its verify path.
- bcrypt migration: core contains no bcrypt code. The spec documents a bcrypt-verify `hasher` that the app supplies, for example one that calls `bcryptjs` inside the app. That hasher verifies `$2a$/$2b$` hashes with bcrypt and hands `pbkdf2-sha256$` hashes to the default PBKDF2 hasher, which `feathers/authentication` exports as `pbkdf2Hasher`.
- Password comparison: the derived bytes are compared with a loop that touches every byte, with no early return. API-key comparison uses the same `timingSafeEqual` over SHA-256 digests (see Strategy interface).
- Rehash failure: a rejected rehash patch writes a log line with the user id and never the password or either hash, and the login still returns 201.
- API key: the key never appears in a log line, a response body, or a thrown error `data`. A missing or wrong key returns `NotAuthenticated('Invalid login')`.
- Unknown user: the local strategy hashes the submitted password against a fixed dummy salt before throwing, so response time does not reveal whether the email exists.
- Error text: every local-login failure returns `NotAuthenticated('Invalid login')` (v5 default, `strategy.ts:31`).
- The `password` field never appears in an authentication response, a users-service external result, or a thrown error `data`.
- `secret` is read from config only. The code never logs it or the token (debug output prints strategy names and ids).
- `iterations` below 100,000 fails `setup()`.

## Tests

All tests live in `packages/feathers/src/authentication/*.test.ts` and call `createHandler(app)` with `new Request(...)` objects. Pure-function tests (base64url, hash format) may call the function.

Fixture: an app with an in-memory `users` service, an `authentication` service, and a `messages` service with `authenticate('jwt')`. A second service, `reports`, uses `authenticate('api-key')`. Core tests use the in-memory users service only.

One integration test lives in `packages/kysely` (which lists the `feathers` workspace package as a devDependency). It runs local login against a Postgres users table.

## Done when

1. `test:` POST `/authentication` with `{ strategy: 'local', email, password }` for a valid user returns 201 with an `accessToken` string and no `password` key anywhere in the body.
2. `test:` POST `/authentication` with a wrong password and POST with an unknown email both return 401 with the same message `Invalid login`.
3. `test:` GET `/messages` with no `Authorization` header returns 401.
4. `test:` GET `/messages` with `Authorization: Bearer <accessToken>` returns 200.
5. `test:` GET `/messages` with a token whose `exp` is in the past returns 401.
6. `test:` GET `/messages` with a token signed by a different secret, and with a token whose header says `alg: none`, each return 401.
7. `test:` `app.service('messages').find()` called with no `provider` succeeds without a token.
8. `test:` GET `/users` returns user records without a `password` key.
9. `test:` GET `/sse` (the SSE service) with a valid Bearer header opens a stream, and a `messages` create by that user's channel arrives with `connection.user` set; the same request without a header returns 401.
10. `test:` an SSE stream opened with a token that expires in 1 second ends within 2 seconds.
11. `test:` a token minted by the implementation verifies with `jose` (devDependency), and the RFC 7515 HS256 vector verifies in the implementation.
12. `test:` a stored hash with `iterations: 100000` still verifies after `local.iterations` is raised to 200000.
13. `cmd:` `grep -c '"dependencies"' packages/feathers/package.json` prints `0`.
14. `cmd:` `pnpm --filter feathers test` passes on Node 22, and the authentication tests pass under `bun test` and `deno test` (runner commands to be fixed in the plan).
15. `cmd:` a Workers smoke script (`wrangler dev` or `workerd`) logs in and calls a protected route.
16. `test:` with an app-supplied `hasher` that verifies bcrypt, POST `/authentication` with `{ strategy: 'local' }` for a user whose stored hash is a `$2b$` bcrypt hash returns 201 with an `accessToken`, and a wrong password returns 401 `Invalid login`.
17. `test:` with the same `hasher`, a user whose stored hash starts with `pbkdf2-sha256$` also logs in, so one app holds both formats.
18. `cmd:` `grep -rniE 'bcrypt' packages/feathers/src` prints no match outside test files, and `grep -c '"dependencies"' packages/feathers/package.json` still prints `0`.
19. `test:` the POST `/authentication` response body has no `refreshToken` key, and POST `/authentication` with `{ strategy: 'refresh' }` returns 401.
20. `test:` `app.reAuthenticate()` with a stored token whose `exp` is in the past rejects with `NotAuthenticated`, and the client sends no request to `/authentication` during that call.
21. `test:` GET `/sse` with no `Authorization` header and `?ticket=abc` returns 401, and POST `/authentication` with `{ strategy: 'sse-ticket' }` returns 401 in tier 1.
22. `test:` GET `/reports` with the configured API-key header and a listed key returns 200; a wrong key and a missing header each return 401 `Invalid login`.
23. `test:` with `apiKey.verify` set, a key for which `verify` returns null gets 401, and a key for which it returns `{ client: 'a' }` gets 200 with `params.apiKey.client === 'a'` in the service.
24. `test:` POST `/authentication` with `{ strategy: 'api-key' }` returns 401, and `setup()` throws when `authStrategies` contains `'api-key'` or when `apiKey` sets both `keys` and `verify`, or neither.
25. `test:` the API-key comparison runs `timingSafeEqual` over equal-length SHA-256 digests, so a key of different length than every configured key takes the same code path as a same-length wrong key (unit test on the comparison function, which counts byte visits).
26. `cmd:` `grep -c 'supersecret' packages/create-feathers/src/templates/authenticate.tpl.ts` prints `0`, and the template calls `authenticate('jwt', 'api-key')`.
27. `test:` with a stored `$2b$` bcrypt hash and the bcrypt-verify `hasher`, a successful POST `/authentication` with `{ strategy: 'local' }` leaves the user's stored hash starting with `pbkdf2-sha256$`, and a second login with the same password returns 201.
28. `test:` with a stored `pbkdf2-sha256$100000$...` hash and `local.iterations` of 200000, a successful login rewrites the stored hash to carry iteration count 200000; with a stored hash at the current count, the users service receives no `patch` call.
29. `test:` when the users-service `patch` rejects during rehash, POST `/authentication` still returns 201 with an `accessToken`, and the log holds one entry with the user id and no password or hash text.
30. `test:` the rehash patch carries no `provider`, and the users-service `hashPassword('password')` hook does not hash the value a second time (the stored hash verifies against the original password).
31. `test:` in `packages/kysely`, local login against a Postgres users table with a PBKDF2 hash returns 201 with an `accessToken`, and a wrong password returns 401 `Invalid login`.
32. `James:` the scaffold in `create-feathers` generates a project whose `authenticate` hook uses `feathers/authentication` and whose README login example works.
33. `test:` a local login token carries `auth_time` (seconds) and `exp` equal to `auth_time + expiresIn`; after time advances, POST `/authentication` with `{ strategy: 'jwt', accessToken }` returns a token whose `exp` equals the presented token's `exp` and whose `auth_time` matches; a valid token with no `auth_time` gets 401 at that call and 200 on a protected route.

## Won't

- The first release will not include OAuth, social login, or provider profiles.
- The first release will not store tokens server-side. There is no token revocation list and no refresh tokens. Clients log in again on expiry; a refresh strategy is tier 2.
- The first release will not accept access tokens in query strings.
- The first release will not authenticate a native browser `EventSource`, and the SSE service ignores `?ticket=`. The single-use ticket flow is tier 2.
- The first release will not let the `api-key` strategy mint an access token or load a user entity.
- The first release will not add a WebSocket transport or socket authentication.
- The first release will not bundle bcrypt or Argon2. Apps pass their own `hasher` for either, including the bcrypt-verify `hasher` that migrates v5 hashes.
- The first release will not add role or permission checks (authorization). Apps write those hooks.

## Decisions

- 2026-10-20 James: authentication ships as the core subpath `feathers/authentication`, with zero runtime dependencies (Option A).
- 2026-10-20 James: tier 1 ships a pluggable `hasher` interface. The default hasher is PBKDF2-SHA256 at 600,000 iterations. A Workers deployment that hits an iteration cap swaps in another hasher.
- 2026-10-20 James: v5 bcrypt hashes verify through the tier 1 pluggable `hasher`. Core ships no bcrypt code; the spec documents a bcrypt-verify hasher the app supplies (for example with `bcryptjs`), and the hash prefix (`$2a$/$2b$` against `pbkdf2-sha256$`) lets the hasher tell the formats apart.
- 2026-10-20 James: tier 1 has no refresh tokens, and clients log in again on expiry. A refresh strategy moves to tier 2 in the scope table, next to RS256/JWKS.
- 2026-10-20 James: kept the spec pass's added calls (id column always accepted, dotted query keys rejected, columns whitelist excludes create/patch data keys, `pbkdf2Hasher` export).
- 2026-10-20 James: answered open question 4. Tier 1 authenticates SSE only through the `Authorization` header, because the v6 client streams SSE over `fetch`. The single-use ticket flow for native `EventSource` stays in tier 2.
- 2026-10-20 James: answered open question 5. Tier 1 ships a named `api-key` strategy next to `jwt` and `local` on the same `authenticate()` path, and it replaces the scaffold's API-key hook in `authenticate.tpl.ts`. Config: header name plus a key list or a verify function; comparison is timing-safe.
- 2026-10-20 James: answered open question 7. `PasswordHasher` has `hash(password)`, `verify(password, hash)`, and `needsRehash(hash)`. After a successful local login where `needsRehash` returns true, the local strategy hashes the password with the default hasher and patches the user through the users service (internal call, no provider). A failed rehash patch does not fail the login; it is logged.
- 2026-10-20 James: approved this spec for build.
- 2026-10-21 James: a token minted from the jwt strategy keeps the original login's absolute expiry through an auth_time claim.

## Open questions for James

1. Answered 2026-10-20: core subpath. See Decisions.
2. Answered 2026-10-20: pluggable hasher in tier 1, PBKDF2 at 600,000 by default. See Decisions.
3. Answered 2026-10-20: yes, through the tier 1 pluggable `hasher`; core ships no bcrypt code. See Decisions.
4. Answered 2026-10-20: tier 1 authenticates SSE only through the Authorization header; the ticket flow stays in tier 2. See Decisions.
5. Answered 2026-10-20: tier 1 ships a named `api-key` strategy next to `jwt` and `local`, replacing the scaffold's API-key hook. See Decisions.
6. Answered 2026-10-20: tier 1 has no refresh tokens; a refresh strategy is tier 2. See Decisions.
7. Answered 2026-10-20: `PasswordHasher` defines `hash`, `verify`, and `needsRehash`; the local strategy rehashes on login and patches the user through the users service, and a failed patch is logged. See Decisions.
