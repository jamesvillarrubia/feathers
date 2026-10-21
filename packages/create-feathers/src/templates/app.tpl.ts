import { renderTemplate, runGenerators, toFile } from '@featherscloud/pinion'
import type { AppGeneratorContext } from '../commons.js'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Set __dirname in es module
const __dirname = dirname(fileURLToPath(import.meta.url))

const template = ({ sse }: AppGeneratorContext) => /* ts */ `import { feathers } from 'feathers'
import type { HookContext as FeathersHookContext, Application as FeathersApplication } from 'feathers'
import { AuthenticationService } from 'feathers/authentication'
import { MessageService } from './services/messages.js'
${sse ? `import { SseService } from './services/sse.js'` : ''}

export type Services = {
  messages: MessageService
  ${sse ? `sse: SseService` : ''}
}

export type Configuration = {
}

export type Application = FeathersApplication<Services, Configuration>

export type HookContext = FeathersHookContext<Application>

const app: Application = feathers<Services, Configuration>()

// Requests authenticate with a JWT or with an API key. Both values come from the environment (see .env).
// Add a users service and set \`service\`, \`entity\` and \`local\` to let users log in with email and password.
app.use(
  'authentication',
  new AuthenticationService({
    secret: process.env.AUTH_SECRET as string,
    entity: null,
    service: 'users',
    authStrategies: ['jwt'],
    apiKey: { header: 'x-api-key', keys: [process.env.API_KEY as string] }
  })
)
${sse ? `app.use('sse', new SseService())` : ''}
app.use('messages', new MessageService())

${
  sse
    ? `// On a real-time connection, add the connection to the appropriate channel
app.on('connection', (connection) => {
  if (connection.user) {
    app.channel('authenticated').join(connection)
  } else {
    app.channel('anonymous').join(connection)
  }
})

// Only publish events to authenticated users
app.publish(() => app.channel('authenticated'))`
    : ''
}

export { app }
`

export const generate = (ctx: AppGeneratorContext) =>
  Promise.resolve(ctx)
    .then(renderTemplate(template, toFile('src', 'app.ts')))
    .then(runGenerators(__dirname, 'services'))
