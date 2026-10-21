import assert from 'node:assert'
import { beforeEach, describe } from 'vitest'
import { AdapterBasicTest } from './declarations.js'

export default (test: AdapterBasicTest, app: any, _errors: any, serviceName: string, idProp: string) => {
  describe('Basic Functionality', () => {
    let service: any

    beforeEach(() => {
      service = app.service(serviceName)
    })

    test('.id', () => {
      assert.strictEqual(service.id, idProp, 'id property is set to expected name')
    })

    test('.options', () => {
      assert.ok(service.options, 'Options are available in service.options')
    })

    test('.events', () => {
      assert.ok(service.events.includes('testing'), 'service.events is set and includes "testing"')
    })
  })
}
