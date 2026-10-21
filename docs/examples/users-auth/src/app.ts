import { Kysely, PostgresDialect, type Generated } from 'kysely'
import pg from 'pg'
import { feathers } from 'feathers'
import { AuthenticationService, authenticate, hashPassword, protect } from 'feathers/authentication'
import { KyselyService } from '@jamesvillarrubia/feathers-kysely'

interface Database {
  users: { id: Generated<number>; email: string; password: string }
  messages: { id: Generated<number>; text: string }
}

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) })
})
export const app = feathers<any>()

app.use('users', new KyselyService({ db, table: 'users', columns: ['id', 'email', 'password'] }))
app.service('users').hooks({
  around: { all: [protect('password')], create: [hashPassword('password')] }
})

app.use('messages', new KyselyService({ db, table: 'messages', columns: ['id', 'text'] }))
app.service('messages').hooks({ around: { all: [authenticate('jwt')] } })

const secret = process.env.AUTH_SECRET
if (!secret) throw new Error('AUTH_SECRET is required')

app.use(
  'authentication',
  new AuthenticationService({
    secret,
    service: 'users',
    authStrategies: ['jwt', 'local'],
    local: {}
  })
)
