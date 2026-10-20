# Kysely Postgres adapter for Feathers v6

Feathers v6 ships no database adapter, so an app that wants Postgres storage must write the six service methods by hand; this spec defines a Postgres adapter, built on the Kysely query builder, that supplies them.

Status: draft for James. Branch: `feature/v6-hooks-all-methods`. Every `path:line` below was read in this session. v5 paths refer to `refs/remotes/upstream/dove`.

## Problem

The v6 `feathers` package contains `application.ts`, `hooks.ts`, `http/`, `client/`, `channel/` and no adapter code. A search of `packages/` for `MemoryService`, `adapter-tests` and `adapter-commons` (`/usr/bin/grep -rIl -i -E 'MemoryService|adapter-tests|adapter-commons' packages --include=*.ts --include=package.json --exclude-dir=node_modules`) returns no files, and `find packages -maxdepth 2 -iname '*memory*'` returns none. v5 had `packages/adapter-commons`, `packages/knex`, `packages/memory` and `packages/adapter-tests` on the `dove` branch.

Users who move to v6 have no maintained way to expose a Postgres table as a Feathers service with `$limit`, `$skip`, `$sort`, `$select` and the comparison operators. Kysely gives a typed query builder with no runtime dependencies, which matches the zero-dependency direction of the `feathers` package.

## v6 service interface for adapters

- `ServiceMethods` declares `find`, `get`, `create`, `update`, `patch`, `remove`, plus optional `setup` and `teardown` (`packages/feathers/src/declarations.ts:81-102`).
- `find` receives `ServiceParams & { paginate?: PaginationParams }` (`declarations.ts:87`). `PaginationParams` is `false | { default?, max? }` (`declarations.ts:381-386`).
- `Paginated<T>` is `{ total, limit, skip, data }` (`declarations.ts:17-22`).
- `Id` is `number | string`; `NullableId` adds `null` (`declarations.ts:366-367`). `Params` carries `query`, `provider`, `route`, `headers`, `connection` (`declarations.ts:373-379`). It has no `transaction` field, so the adapter declares its own params type that extends `Params`.
- `ServiceOptions` has `events`, `methods`, `externalMethods`, `serviceEvents`, `routeParams` (`declarations.ts:27-52`). `externalMethods` lists methods reachable over HTTP or WebSocket and defaults to `methods` (`service.ts:51-53`, `service.ts:64-65`). The HTTP layer rejects a method missing from that list (`http/index.ts:142-147`).
- `normalizeServiceOptions` derives `methods` from the functions present on the service object (`service.ts:59-62`). An adapter that defines all six methods gets all six hooks and external methods by default.
- `protectedMethods` blocks the names `all`, `around`, `before`, `after`, `error`, `hooks`, `setup`, `teardown`, `publish`, `registerPublisher` from being exposed (`service.ts:26-39`). Adapter helper methods use other names, or sit behind `externalMethods`.
- Query strings parse through the in-repo `qs.ts`, which is wire-compatible with `qs@6` and returns string values (`qs.ts:1-6`). Numeric `$limit` and `$skip` therefore arrive as strings from HTTP and need parsing, as v5 does (`adapter-commons/src/query.ts:6`).
- `Conflict`, `BadRequest`, `NotFound`, `MethodNotAllowed`, `Unprocessable`, `Forbidden`, `Unavailable`, `GeneralError` exist in `errors.ts` (lines 67-179).
- The test runner is vitest (`package.json:44-46`). CI runs Node 20.x and 24.x (`.github/workflows/nodejs.yml:10-11`). `packages/feathers/package.json:107-109` sets `engines.node >= 20`; the root `package.json` sets `>= 22`.

## v5 behavior that carries over

- `AdapterBase` defaults: `id: 'id'`, `events: []`, `paginate: false`, `multi: false`, `filters: {}`, `operators: []` (`adapter-commons/src/service.ts:33-41`).
- `allowsMulti`: `find` is always multi, `get` and `update` never, `create`, `patch`, `remove` follow `multi` (`service.ts:12-16`, `service.ts:58-72`).
- `getOptions` merges `params.paginate` and `params.adapter` over the constructor options per call (`service.ts:81-89`).
- `sanitizeQuery` rejects unknown `$` keys with `BadRequest` (`query.ts:20-22`, `query.ts:58-61`) and parses `$skip`, `$limit`, `$sort`, `$select` (`query.ts:92-118`).
- `getLimit` clamps `$limit` to `paginate.max` and falls back to `paginate.default` (`query.ts:76-88`).
- Default operators: `$in $nin $lt $lte $gt $gte $ne $or`, plus `$and` as a filter (`query.ts:90`, `query.ts:126-132`).
- Knex adds `$like`, `$notlike`, `$ilike` (`knex/src/adapter.ts:17-25`, `:53-59`).
- Knex `_find` counts rows only when `paginate.default` is set, and returns `[]` without querying when `$limit` is 0 (`adapter.ts:199-210`).
- Knex `_create` accepts an array by looping single inserts (`adapter.ts:249-251`), returns the row through `_get` so `$select` applies (`adapter.ts:264-267`).
- Knex `_patch` and `_remove` look up matching ids first, act on `id IN (...)`, and return the affected rows (`adapter.ts:288-317`, `:352-372`).
- Knex `_update` rejects `id === null` and array data with `BadRequest` and writes `null` for fields absent from the replacement (`adapter.ts:321-334`).
- Knex `_patch` strips the id field from the payload (`adapter.ts:287`).
- `$select` always includes the id column (`adapter.ts:141`).
- The v5 transaction hooks `start`, `end`, `rollback` open a transaction in a `before` hook and commit or roll back in `after` or `error`, and nest through `transaction.parent` (`knex/src/hooks.ts:18-98`).
- The adapter-tests suite names 85 tests (`adapter-tests/src/declarations.ts`) across `basic.ts`, `methods.ts`, `syntax.ts`, covering `.get`, `.find`, `.create`, `.update`, `.patch`, `.remove`, multi variants, `$sort`, `$limit`, `$or`, `$nin`, `$ne`, `$gt/$lt`, `$and`, `params.adapter` and `paginate`.

## v5 behavior this spec drops

- Knex passthrough `params.knex` (a prebuilt query builder that `_find` clones, `adapter.ts:181`). Kysely has no equivalent that survives typing; users add a custom method instead.
- SQLite, MySQL, MSSQL and Oracle branches: the `RETURNING_CLIENTS` list and the `mssql` default sort (`adapter.ts:27`, `:195-197`), the SQLite error table (`error-handler.ts:39-63`), and the MySQL `sqlState` table (`error-handler.ts:9-38`). The adapter targets Postgres only.
- `tableOptions.only` (`knex/src/declarations.ts`).
- The `NULL` fill in `update`: v5 writes `null` for every field absent from the replacement (`adapter.ts:327-331`). The new `update` rejects a payload that omits a non-id column with `BadRequest` and never writes `NULL` for a missing column. `patch` covers partial writes.
- Unrestricted column names in queries: v5 passes any query key, `$select` entry, and `$sort` key to SQL. The new adapter rejects any of them that is not in the required `columns` option.
- `extendedOperators` as a free-form operator-to-SQL string map (`adapter.ts:91-95`). The replacement is a typed `operators` option (see API).
- The Postgres error table in v5 maps class 23 (including unique violation) to `BadRequest` and class 22 to `NotFound` (`error-handler.ts:72-78`). The new table maps `23505` to `Conflict` and class 22 to `BadRequest`.
- Per-row `Promise.all` inserts for array `create` (`adapter.ts:250`). The new adapter issues one multi-row `INSERT ... RETURNING *`.
- The `transaction` object with `starting`, `committed`, `resolve`, `promise` fields (`knex/src/declarations.ts`) and the `Date.now()` transaction id (`hooks.ts:47`). A Kysely transaction is a callback scope, so the new design is simpler (see Transactions).
- The `VALIDATED` symbol that skips sanitising (`adapter-commons/src/service.ts:10`, `:102-104`) stays out of v1 of the adapter; schema validation hooks run before the adapter regardless.

## Package placement

Option A: new workspace package `packages/kysely`.
Option B: subpath export `feathers/kysely` inside `packages/feathers`.

Recommendation: Option A.

- `packages/feathers/package.json` declares no `dependencies` or `peerDependencies` (search: `grep -n -E "dependencies|peerDependencies" packages/feathers/package.json` returns no match). A `feathers/kysely` subpath would add `kysely` and `pg` as optional peers and break the zero-dependency property.
- `workspaces: ["packages/*"]` (`package.json`) already picks up a new directory.
- The adapter releases on Kysely's and `pg`'s schedule, not on core's.
- The package name is an open question; the working name is `@feathersjs/kysely`.

Layout:

```
packages/kysely/
  package.json        # peerDependencies: feathers, kysely (>=0.27); devDependencies: pg
  src/index.ts        # KyselyService, errors, transaction helper
  src/query.ts        # sanitise + SQL mapping
  src/errors.ts       # pg error mapping
  test/               # vitest, real Postgres
packages/adapter-tests/   # ported suite, private workspace package
```

The shared suite lives in its own workspace package so a future adapter can reuse it.

## API contract

```ts
import type { Kysely, Transaction } from 'kysely'
import type { Params, Paginated, PaginationParams, Id, NullableId, Query } from 'feathers'

export interface KyselyServiceOptions<DB, TB extends keyof DB & string> {
  db: Kysely<DB>
  table: TB
  schema?: string
  id?: keyof DB[TB] & string              // default 'id'
  columns: readonly (keyof DB[TB] & string)[]   // required; the only names a query may reference
  paginate?: PaginationParams             // default false
  multi?: boolean | ('create' | 'patch' | 'remove')[]   // default false
  events?: string[]
  operators?: string[]                    // extra $ keys the sanitiser lets through
  filters?: Record<string, (value: unknown, options: KyselyServiceOptions<DB, TB>) => unknown>
}

export interface KyselyParams<Q = Query> extends Params<Q> {
  transaction?: Transaction<any>
  adapter?: Partial<Pick<KyselyServiceOptions<any, any>, 'paginate' | 'multi' | 'table' | 'schema' | 'id'>>
}

export class KyselyService<DB, TB extends keyof DB & string, Result = Selectable<DB[TB]>,
  Data = Insertable<DB[TB]>, PatchData = Updateable<DB[TB]>> {
  find(params: KyselyParams & { paginate: false }): Promise<Result[]>
  find(params?: KyselyParams): Promise<Paginated<Result> | Result[]>
  get(id: Id, params?: KyselyParams): Promise<Result>
  create(data: Data[], params?: KyselyParams): Promise<Result[]>
  create(data: Data, params?: KyselyParams): Promise<Result>
  update(id: Id, data: Data, params?: KyselyParams): Promise<Result>
  patch(id: Id, data: PatchData, params?: KyselyParams): Promise<Result>
  patch(id: null, data: PatchData, params?: KyselyParams): Promise<Result[]>
  remove(id: Id, params?: KyselyParams): Promise<Result>
  remove(id: null, params?: KyselyParams): Promise<Result[]>
}
```

- `Selectable`, `Insertable`, `Updateable` come from Kysely, so the DB type drives `Result`, `Data`, `PatchData`.
- `columns` takes its element type from `keyof DB[TB] & string`, so `tsc` rejects a name that is not a column of the table type. The option is required: a `KyselyService` constructed without `columns` fails to compile, and the constructor throws `Error('You must provide a columns list')` at runtime for untyped callers.
- The adapter always accepts the `id` option's column, even when `columns` omits it.
- `Insertable` marks columns with defaults as optional, so the `Data` type of `update` does not enforce a full row. `update` enforces it at runtime (see Method behavior).
- `KyselyService` implements the six methods that `ServiceMethods` requires (`declarations.ts:81-102`). `setup` and `teardown` are absent; the app owns the Kysely instance and its pool.
- The constructor throws `Error('You must provide a Kysely instance as db')` when `db` is missing and `Error('No table name specified.')` when `table` is not a string (the v5 messages at `knex/src/adapter.ts:38-44`, reworded).
- Registration: `app.use('users', new KyselyService({ db, table: 'users', columns: ['id', 'name', 'age'], paginate: { default: 10, max: 50 } }))`. `methods` and `externalMethods` default as in `service.ts:59-65`.
- Row typing: `find` without `paginate: false` returns `Paginated<Result>` when options set `paginate.default`, and `Result[]` otherwise.

## Query syntax and SQL mapping

All examples assume table `users` and Kysely's identifier quoting.

| Query | SQL |
|---|---|
| `{ name: 'a' }` | `"name" = $1` |
| `{ name: null }` | `"name" IS NULL` |
| `{ age: { $gt: 3 } }` and `$gte $lt $lte` | `"age" > $1` and `>= < <=` |
| `{ age: { $ne: 3 } }` | `"age" <> $1` |
| `{ age: { $ne: null } }` | `"age" IS NOT NULL` |
| `{ age: { $in: [1,2] } }` | `"age" IN ($1,$2)` |
| `{ age: { $nin: [1,2] } }` | `"age" NOT IN ($1,$2)` |
| `{ age: { $in: [] } }` | `FALSE` (matches no rows) |
| `{ age: { $nin: [] } }` | `TRUE` (matches all rows) |
| `{ name: { $like: 'a%' } }`, `$notlike`, `$ilike` | `LIKE`, `NOT LIKE`, `ILIKE` |
| `{ $or: [{a:1},{b:2}] }` | `("a" = $1 OR "b" = $2)` |
| `{ $and: [{a:1},{b:2}] }` | `("a" = $1 AND "b" = $2)` |
| `{ $sort: { age: -1, name: 1 } }` | `ORDER BY "age" DESC, "name" ASC` |
| `{ $select: ['name'] }` | `SELECT "users"."name", "users"."id"` (id always added, as `adapter.ts:141`) |
| `{ $limit: 5 }` | `LIMIT 5` |
| `{ $skip: 10 }` | `OFFSET 10` |

- Several operators on one column combine with `AND`: `{ age: { $gt: 1, $lt: 9 } }` yields `"age" > $1 AND "age" < $2`.
- Every value is a bind parameter. No query value reaches the SQL text. Column names come from query keys and `$sort`/`$select`; the adapter checks each against `columns` (plus the id column) and then passes it through `sql.ref` or `eb.ref`, which quotes identifiers.
- A query key, `$select` entry, or `$sort` key that is not in `columns` throws `BadRequest("Invalid column 'x'")` before any SQL runs. The check also covers keys nested inside `$or` and `$and`. A client cannot probe for column names through Postgres errors.
- A dotted key such as `profile.age` is not in `columns` and throws `BadRequest`. Nested JSON-path queries and joined-table references are not supported.
- A `$` key not in the allowed set throws `BadRequest('Invalid query parameter $x')` (v5 text, `query.ts:21`).
- `$sort` values other than `1` and `-1` throw `BadRequest`.
- `$limit: 0` returns `{ total, limit: 0, skip, data: [] }` with a count query when paginated, and `[]` without a query when not paginated.
- `total` comes from `SELECT count(*)` over the same `WHERE`, run only when `paginate.default` is set (`adapter.ts:201`). The count is returned as a number (Postgres `count` returns `bigint`, which `pg` delivers as a string; the adapter parses it).
- `$limit` and `$skip` accept numeric strings, per `qs.ts` output. A non-numeric `$limit` falls back to `paginate.default` (`query.ts:80-81`).

## Method behavior

- `find`: sanitise `params.query`, build `WHERE`, `ORDER BY`, `LIMIT`, `OFFSET`; paginate as above.
- `get(id, params)`: `WHERE id = $1 AND <query>`; zero rows throws `NotFound("No record found for id 'x'")`.
- `create(data)`: one `INSERT ... RETURNING *`. An array needs `multi` to include `create`, otherwise `MethodNotAllowed('Can not create multiple entries')` (`knex/src/index.ts:42-44`). An array inserts in one statement and returns rows in input order. `$select` in `params.query` applies to the returned rows.
- `update(id, data)`: full-row only. `id` required; `null` throws `BadRequest` (`adapter.ts:321-323`). `data` must contain every non-id column in `columns`; a payload that omits any of them throws `BadRequest` naming the missing columns, before any SQL runs. `update` never writes `NULL` for a missing column. When `data` is complete, one `UPDATE ... SET` writes every non-id column and returns the row. A row that does not match `id` plus query throws `NotFound`. Callers who want a partial write use `patch`.
- `patch(id, data)`: strips the id field from `data`, runs `UPDATE ... WHERE id = $1 AND <query> RETURNING *`. `patch(null, ...)` needs `multi` to include `patch` (`MethodNotAllowed('Can not patch multiple entries')`), updates every row matching the query, and returns them. An empty `data` after stripping returns the current row or rows without issuing `UPDATE`.
- `remove(id)`: `DELETE ... WHERE id = $1 AND <query> RETURNING *`. `remove(null)` follows the same `multi` rule.
- `patch` and `remove` ignore `$limit`, `$skip`, `$sort` for the write (`knex/src/index.ts:60`, `:72` drop `$limit`).
- Single-statement `RETURNING` replaces the v5 read-then-write sequences (`adapter.ts:288-307`, `:352-362`), which race between the id lookup and the write.
- `params.adapter` overrides `paginate`, `multi`, `table`, `schema`, `id` for one call (`service.ts:81-89`).

## Transactions

Kysely runs a transaction as `db.transaction().execute(async (trx) => ...)`, which commits when the callback resolves and rolls back when it throws.

- Every method reads `params.transaction ?? options.db` as its executor.
- The package exports `withTransaction(app, db, fn)`, which calls `db.transaction().execute((trx) => fn(trx))`; the callback passes `{ transaction: trx }` in `params` to each service call.
- The package also exports an `around` hook, `transaction(db)`. It opens a transaction, sets `context.params.transaction`, awaits `next()`, and lets Kysely commit on return or roll back on throw. If `context.params.transaction` already exists, the hook calls `next()` and opens no second transaction (a nested service call joins the outer one).
- The v5 pair of `before` and `after`/`error` hooks (`knex/src/hooks.ts`) is replaced by one `around` hook because v6 `HookMap` supports `around` (`declarations.ts:505-521`). Read `packages/feathers/src/hooks.ts` before implementation to confirm `around` hooks may wrap an adapter service on every method and that errors thrown inside `next()` propagate to the hook.
- A transaction is not shared across a `setup` boundary or between requests.

## Error mapping

The adapter wraps each query in a `try`/`catch` and rethrows a Feathers error. The original error is kept on the Feathers error under a symbol `ERROR = Symbol.for('feathers/kysely/error')` (same pattern as `error-handler.ts:3`, `:95`). A Feathers error thrown inside the adapter (`NotFound`, `MethodNotAllowed`, `BadRequest`) passes through unchanged.

| Postgres SQLSTATE | Feathers error |
|---|---|
| `23505` unique_violation | `Conflict` |
| `23503` foreign_key_violation | `Conflict` |
| `23502` not_null_violation, `23514` check_violation, other class `23` | `BadRequest` |
| class `22` (data exception, e.g. invalid input syntax for an integer) | `BadRequest` |
| `42703` undefined_column, `42P01` undefined_table, other class `42` | `Unprocessable` |
| class `28` (auth) | `Forbidden` |
| class `08` (connection), `57P03`, `53300` | `Unavailable` |
| `40001` serialization_failure, `40P01` deadlock_detected | `Unavailable` (client may retry) |
| anything else | `GeneralError` |

- The mapping reads `error.code` on the `pg` `DatabaseError`; the check follows the v5 shape `typeof error.code === 'string' && error.severity && error.routine` (`error-handler.ts:64`).
- The message sent to the client is the `pg` `detail` or `message` with the SQL text removed. v5 trims by splitting on `-` (`error-handler.ts:67-70`), which breaks on messages containing a hyphen; the new code uses `error.message` without query text, because `pg` does not put SQL in `message`.
- The original `pg` error stays reachable via the `ERROR` symbol and is not serialised to the client.

## Tests

Tests run at the service boundary against a real Postgres. A mock Kysely would test the SQL string, not the behavior.

- Postgres runs in a container under OrbStack. Before any `docker` command, `docker context show` must print `orbstack`. The test setup reads `DATABASE_URL`, and a `docker-compose.yml` in `packages/kysely/test/` starts `postgres:16` on a free port with a tmpfs data directory.
- CI adds a `services: postgres` block to `.github/workflows/nodejs.yml` (which has no `services:` block today; search: `grep -n -E 'services:|postgres' .github/workflows/*.yml` returns no match).
- `packages/adapter-tests` ports v5 `adapter-tests/src/{basic,methods,syntax}.ts` from mocha globals to vitest (`it`, `describe`, `afterAll`). The 85 test names stay, minus those for dropped features.
- The suite calls the service through `app.use(...)` and the service methods, and a second pass calls it through the v6 HTTP handler (`packages/feathers/src/http/index.ts`) with `fetch`/`Request`, so `externalMethods`, query-string parsing, and error status codes are covered end to end.
- The v5 adapter-tests that call `update` with a partial payload and expect `null` fill are dropped; a replacement test asserts the `BadRequest`.
- Added tests beyond v5: `update` with a missing column returns `BadRequest` and leaves the row unchanged, a query key, `$select` entry, and `$sort` key outside `columns` each return `BadRequest`, `$like`/`$ilike`, `$in: []`, `$nin: []`, `$ne: null`, unique violation returns `Conflict` with HTTP 409, transaction commit, transaction rollback on a thrown error, nested transaction joins the outer one, `create` of an array keeps input order, and `patch(null)` is atomic (a concurrent insert between lookup and write cannot be missed).
- Types: a `tsd`-style compile test asserts that `service.get(1)` has the `Selectable<DB['users']>` type, that `create` rejects a field missing from `Insertable`, that constructing `KyselyService` without `columns` is a type error, and that a `columns` entry outside the table type is a type error.
- Coverage threshold follows the repo `vitest.config.ts`.

## Done when

1. `test:` `npm test -w packages/kysely` passes all ported adapter-tests (85 names minus the dropped list) against Postgres 16 started in OrbStack.
2. `test:` an HTTP-boundary test posts `{ "email": "a@x.io" }` twice to a table with a unique `email` column; the second response has status 409 and `name: "Conflict"`.
3. `test:` a transaction test creates a row in a service call inside `withTransaction`, throws, and `find` afterwards returns no such row.
4. `test:` `GET /users?$limit=2&$skip=1&$sort[age]=-1&age[$gt]=18` returns `{ total, limit: 2, skip: 1, data }` with `data` sorted by `age` descending and every `age > 18`.
5. `test:` `GET /users?$foo=1` returns 400 with message `Invalid query parameter $foo`.
6. `cmd:` `docker context show` prints `orbstack` before the test run starts; the test script exits non-zero otherwise.
7. `cmd:` `npm run compile -w packages/kysely` produces `lib/index.js` and `lib/index.d.ts` with no `tsc` errors.
8. `cmd:` `npm ls -w packages/kysely --omit=dev --omit=peer` lists no runtime dependencies.
9. `cmd:` `grep -n -E 'dependencies|peerDependencies' packages/feathers/package.json` is unchanged from `main` of this branch (core stays dependency-free).
10. `cmd:` `.github/workflows/nodejs.yml` runs the Kysely tests on Node 20.x and 24.x with a Postgres service, and the run is green on the PR head SHA.
11. `test:` `service.update(1, { name: 'x' })` on a table whose `columns` include `age` throws `BadRequest` naming `age`, and `service.get(1)` afterwards still returns the original `age`.
12. `test:` `update` with every non-id column present returns the replaced row, and a column set to `null` in the payload is written as `NULL`.
13. `test:` `GET /users?nope=1` returns 400 with message `Invalid column 'nope'`; `GET /users?$select[]=nope` and `GET /users?$sort[nope]=1` each return 400 the same way.
14. `test:` `GET /users?$or[0][nope]=1` returns 400, and `GET /users?profile.age=1` returns 400.
15. `cmd:` a `tsc` compile test fails on `new KyselyService({ db, table: 'users' })` (no `columns`) and on `columns: ['nope']` for a table with no `nope` column.
16. `James:` `reqts/v6-kysely-adapter.md` open questions are answered, and the package name is chosen.
17. `James:` a 20-line example app in `docs/` registers a `users` service and serves `GET /users` from a real database.

## Won't

- Support MySQL, SQLite, MSSQL, or Oracle. Kysely supports them, but this adapter maps Postgres error codes and uses `RETURNING`.
- Ship a migration tool or schema generator. Kysely's `Migrator` and `kysely-codegen` cover that.
- Wrap Kysely's pool lifecycle. The app creates and destroys `Kysely`; the adapter never calls `db.destroy()`.
- Add a memory service to core as part of this work. The test suite targets Postgres only.
- Support JSON-path or full-text query operators in v1. Users reach for a custom service method.
- Keep the v5 `params.knex` query-builder passthrough or `extendedOperators` string map.
- Write generated Kysely table types for the user.
- Fill missing columns with `NULL` in `update`, or accept a partial payload in `update`.
- Read the column list from `information_schema` at runtime. The app supplies `columns`.

## Decisions

- 2026-10-20 James: the adapter lives in a new workspace package, `packages/kysely`, and the ported suite lives in a private `packages/adapter-tests`.
- 2026-10-20 James: `update()` is full-row only. It throws `BadRequest` when the payload omits any non-id column and never writes `NULL` for a missing column. `patch()` covers partial writes. v5's NULL-fill is dropped.
- 2026-10-20 James: a `columns` option is required. The adapter rejects (`BadRequest`) any query key, `$select` entry, or `$sort` key not in `columns`. The option type derives from the Kysely DB table type, so `tsc` checks it.

## Open questions for James

1. Package name: `@feathersjs/kysely`, `feathers-kysely`, or a name under the v6 `feathers` scope? The core package is named plain `feathers` (`packages/feathers/package.json`), so the scope convention is unset.
2. Should the v5 hook-less `_find`, `_get`, `_create`, `_update`, `_patch`, `_remove` family (`adapter-commons/src/service.ts:121-186`) exist in v6? The spec omits them and sanitises inside the public methods. Dropping them means a server-side caller cannot skip query sanitising.
3. Does v6 keep `params.adapter` per-call overrides (`service.ts:81-89`)? The spec keeps them because two v5 tests (`params.adapter + paginate`, `params.adapter + multi`) exercise them.
4. Should `packages/adapter-tests` stay a private workspace package, or publish for third-party adapters? The spec assumes private.
5. Answered 2026-10-20: required `columns` option, rejected with `BadRequest` outside it, typed from the DB table type. See Decisions.
6. Minimum versions: Kysely `>=0.27` and `pg` `>=8`? The spec does not pin them; CI cost grows with a version matrix.
7. Does the `around` transaction hook live in this package or move to a generic `feathers/hooks` helper? The spec keeps it local because it needs a Kysely type.
8. Answered 2026-10-20: `update` is full-row only and throws `BadRequest` on an omitted non-id column; v5 NULL-fill dropped. See Decisions.
