import { KyselyService } from '../../../src/index.js'
import { db } from './tables.js'

const service = new KyselyService({ db, table: 'users', columns: ['id', 'email'] })

// email is required by Insertable<UsersTable>
export const result = service.create({ name: 'no email' })
