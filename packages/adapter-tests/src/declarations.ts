export type AdapterTest = (name: AdapterTestName, runner: any) => void

export type AdapterBasicTest = (name: AdapterBasicTestName, runner: any) => void
export type AdapterMethodsTest = (name: AdapterMethodsTestName, runner: any) => void
export type AdapterSyntaxTest = (name: AdapterSyntaxTestName, runner: any) => void

export type AdapterTestName = AdapterBasicTestName | AdapterMethodsTestName | AdapterSyntaxTestName

export const basicTestNames = ['.id', '.options', '.events'] as const

export type AdapterBasicTestName = (typeof basicTestNames)[number]

export const methodsTestNames = [
  '.get',
  '.get + $select',
  '.get + id + query',
  '.get + NotFound',
  '.get + NotFound (integer)',
  '.get + id + query id',
  '.find',
  '.remove',
  '.remove + $select',
  '.remove + id + query',
  '.remove + NotFound',
  '.remove + NotFound (integer)',
  '.remove + multi',
  '.remove + multi no pagination',
  '.remove + id + query id',
  '.update',
  '.update + $select',
  '.update + id + query',
  '.update + NotFound',
  '.update + NotFound (integer)',
  '.update + query + NotFound',
  '.update + id + query id',
  '.patch',
  '.patch + $select',
  '.patch + id + query',
  '.patch multiple',
  '.patch multiple no pagination',
  '.patch multi query same',
  '.patch multi query changed',
  '.patch + NotFound',
  '.patch + NotFound (integer)',
  '.patch + query + NotFound',
  '.patch + id + query id',
  '.create',
  '.create + $select',
  '.create multi',
  '.create ignores query',
  'internal .find',
  'internal .get',
  'internal .create',
  'internal .update',
  'internal .patch',
  'internal .remove'
] as const

export type AdapterMethodsTestName = (typeof methodsTestNames)[number]

export const syntaxTestNames = [
  '.find + equal',
  '.find + equal multiple',
  '.find + $sort',
  '.find + $sort + string',
  '.find + $limit',
  '.find + $limit 0',
  '.find + $skip',
  '.find + $select',
  '.find + $or',
  '.find + $in',
  '.find + $nin',
  '.find + $lt',
  '.find + $lte',
  '.find + $gt',
  '.find + $gte',
  '.find + $ne',
  '.find + $gt + $lt + $sort',
  '.find + $or nested + $sort',
  '.find + $and',
  '.find + $and + $or',
  'params.adapter + paginate',
  'params.adapter + multi',
  '.find + paginate',
  '.find + paginate + query',
  '.find + paginate + $limit + $skip',
  '.find + paginate + $limit 0',
  '.find + paginate + params'
] as const

export type AdapterSyntaxTestName = (typeof syntaxTestNames)[number]

export const allTestNames: AdapterTestName[] = [...basicTestNames, ...methodsTestNames, ...syntaxTestNames]
