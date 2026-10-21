import { renderTemplate, toFile } from '@featherscloud/pinion'
import { AppGeneratorContext } from '../commons'

const template = ({}: AppGeneratorContext) => /* ts */ `import { authenticate } from 'feathers/authentication'

// Accepts a JWT (\`Authorization: Bearer <token>\`) or an API key (the \`x-api-key\` header).
// Extend with the functionality needed for your application.
export const authenticateRequest = authenticate('jwt', 'api-key')
`

export const generate = (ctx: AppGeneratorContext) =>
  Promise.resolve(ctx).then(renderTemplate(template, toFile('src', 'hooks', 'authenticate.ts')))
