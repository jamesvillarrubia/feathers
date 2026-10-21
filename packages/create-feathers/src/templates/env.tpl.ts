import { randomBytes } from 'node:crypto'
import { renderTemplate, toFile } from '@featherscloud/pinion'
import type { AppGeneratorContext } from '../commons.js'

// Random values per generated app. The generated .gitignore lists .env.
const template = () => `AUTH_SECRET=${randomBytes(32).toString('hex')}
API_KEY=${randomBytes(24).toString('hex')}
`

export const generate = (ctx: AppGeneratorContext) =>
  Promise.resolve(ctx).then(renderTemplate(template, toFile('.env')))
