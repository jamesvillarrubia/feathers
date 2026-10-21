/* eslint-disable no-console */
import basicTests from './basic.js'
import { AdapterTestName } from './declarations.js'
import methodTests from './methods.js'
import syntaxTests from './syntax.js'
import { afterAll, describe, it } from 'vitest'

export const adapterTests = (testNames: readonly AdapterTestName[]) => {
  return (app: any, errors: any, serviceName: any, idProp = 'id') => {
    if (!serviceName) {
      throw new Error('You must pass a service name')
    }

    const skippedTests: AdapterTestName[] = []
    const allTests: AdapterTestName[] = []

    const test = (name: AdapterTestName, runner: any) => {
      const skip = !testNames.includes(name)
      const its = skip ? it.skip : it

      if (skip) {
        skippedTests.push(name)
      }

      allTests.push(name)

      its(name, runner)
    }

    describe(`Adapter tests for '${serviceName}' service with '${idProp}' id property`, () => {
      afterAll(() => {
        testNames.forEach((name) => {
          if (!allTests.includes(name)) {
            console.error(`WARNING: '${name}' test is not part of the test suite`)
          }
        })
        if (skippedTests.length) {
          console.log(
            `\nSkipped the following ${skippedTests.length} Feathers adapter test(s) out of ${allTests.length} total:`
          )
          console.log(JSON.stringify(skippedTests, null, '  '))
        }
      })

      basicTests(test, app, errors, serviceName, idProp)
      methodTests(test, app, errors, serviceName, idProp)
      syntaxTests(test, app, errors, serviceName, idProp)
    })
  }
}

export * from './declarations.js'

export default adapterTests
