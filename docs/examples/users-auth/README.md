# Users and auth example

This example is a Feathers v6 app that stores users in Postgres through `KyselyService`, hashes passwords, logs users in with a JWT, and protects `/messages` behind that token.

Run these commands from the repository root. The example links the `feathers` and `@jamesvillarrubia/feathers-kysely` workspace packages, so both need a build first. Docker must be running.

```sh
npm ci
(cd packages/feathers && npm run compile)
(cd packages/kysely && npm run compile)
cd docs/examples/users-auth
npm install
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54330/feathers_example
export AUTH_SECRET=example-secret-change-me-at-least-32-bytes
npm run db:up
npm run db:init
npm start
```

`db:up` starts Postgres 16 on host port 54330 with an empty database named `feathers_example`. `db:init` runs `schema.sql`. `AUTH_SECRET` must be at least 32 bytes. The server listens on port 3030.

In a second terminal, create a user, log in, and call the protected route:

```sh
curl -X POST localhost:3030/users -H 'content-type: application/json' \
  -d '{"email":"a@example.com","password":"secret-pass"}'

curl -X POST localhost:3030/authentication -H 'content-type: application/json' \
  -d '{"strategy":"local","email":"a@example.com","password":"secret-pass"}'

curl localhost:3030/messages -H "authorization: Bearer <accessToken from the login response>"

curl localhost:3030/users
```

`GET /messages` without the header returns 401. `GET /users` returns each user without a `password` field, because `protect('password')` removes it from external results.

`npm run smoke` runs the same calls against the database and exits non-zero when a status or the missing `password` key differs. Stop the database with `docker compose down`.
