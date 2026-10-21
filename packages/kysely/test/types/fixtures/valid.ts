import { KyselyService } from '../../../src/index.js'
import { db } from './tables.js'
import type { User } from './tables.js'

const service = new KyselyService({ db, table: 'users', columns: ['id', 'email', 'age'] })

export async function check() {
  // get() resolves to the Selectable row type, in both directions
  const row = await service.get(1)
  const asUser: User = row
  const back: typeof row = asUser

  // create() accepts an Insertable (id is generated, so optional)
  await service.create({ email: 'a@x.io' })

  return [asUser, back]
}
