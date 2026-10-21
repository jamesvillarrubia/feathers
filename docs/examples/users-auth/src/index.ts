import { createServer } from 'node:http'
import { createHandler } from 'feathers/http'
import { toNodeHandler } from 'feathers/http/node'
import { app } from './app.js'

await app.setup()

const port = Number(process.env.PORT ?? 3030)

createServer(toNodeHandler(createHandler(app))).listen(port, () => {
  console.log(`Feathers example listening on http://localhost:${port}`)
})
