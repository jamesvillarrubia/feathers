import { renderTemplate, toFile } from '@featherscloud/pinion'
import type { AppGeneratorContext } from '../commons.js'

const template = ({ name, description }: AppGeneratorContext) => /* md */ `# ${name}

> ${description}

## About

This project uses [Feathers](http://feathersjs.com), the universal web framework.

## Authentication

The \`messages\` service accepts a JWT or an API key. The generated \`.env\` file holds \`AUTH_SECRET\` and \`API_KEY\`. Your shell does not read it on its own, so the example loads it first.

\`\`\`sh
set -a; source .env; set +a
curl -H "x-api-key: $API_KEY" http://localhost:3030/messages
\`\`\`

## Help

For more information on all the things you can do with Feathers visit [feathersjs.com](https://feathersjs.com).
`

export const generate = (ctx: AppGeneratorContext) =>
  Promise.resolve(ctx).then(renderTemplate(template, toFile('readme.md')))
