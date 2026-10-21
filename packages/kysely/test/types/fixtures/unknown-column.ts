import { KyselyService } from '../../../src/index.js'
import { db } from './tables.js'

export const service = new KyselyService({ db, table: 'users', columns: ['nope'] })
