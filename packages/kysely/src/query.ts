import { BadRequest } from 'feathers/errors'
import type { PaginationParams, Query } from 'feathers'

export type Comparison = '=' | '<>' | '>' | '>=' | '<' | '<=' | 'like' | 'not like' | 'ilike'

export type WhereNode =
  | { type: 'and'; nodes: WhereNode[] }
  | { type: 'or'; nodes: WhereNode[] }
  | { type: 'compare'; column: string; operator: Comparison; value: unknown }
  | { type: 'in'; column: string; values: unknown[]; negate: boolean }

export interface SortEntry {
  column: string
  direction: 'asc' | 'desc'
}

export interface SanitizedQuery {
  where?: WhereNode
  select?: string[]
  sort: SortEntry[]
  limit?: number
  skip?: number
}

export interface QueryOptions {
  id: string
  columns: readonly string[]
  paginate?: PaginationParams
  filters?: Record<string, (value: unknown, options: any) => unknown>
}

/** `$` keys that a `filters` entry may transform. Every one of them is consumed below. */
export const FILTER_KEYS = ['$limit', '$skip', '$sort', '$select', '$or', '$and']

/** Column operators the adapter translates to SQL. */
export const COLUMN_OPERATORS = [
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$ne',
  '$like',
  '$notlike',
  '$ilike',
  '$in',
  '$nin'
]

const COMPARISONS: Record<string, Comparison> = {
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
  $ne: '<>',
  $like: 'like',
  $notlike: 'not like',
  $ilike: 'ilike'
}

const invalidParameter = (key: string) => new BadRequest(`Invalid query parameter ${key}`)
const invalidColumn = (key: string) => new BadRequest(`Invalid column '${key}'`)

const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const proto = Object.getPrototypeOf(value)

  return proto === Object.prototype || proto === null
}

function parseNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : Math.abs(parseInt(value as string, 10))
}

/** Clamps `$limit` to `paginate.max` and falls back to `paginate.default`. */
export function getLimit(limit: number | undefined, paginate?: PaginationParams): number | undefined {
  if (paginate && (paginate.default || paginate.max)) {
    const base = paginate.default || 0
    const lower = typeof limit === 'number' && !isNaN(limit) ? limit : base
    const upper = typeof paginate.max === 'number' ? paginate.max : Number.MAX_VALUE

    return Math.min(lower, upper)
  }

  return typeof limit === 'number' && !isNaN(limit) ? limit : undefined
}

export function sanitizeQuery(query: Query | undefined, options: QueryOptions): SanitizedQuery {
  const raw = query ?? {}

  if (!isPlainObject(raw)) {
    throw new BadRequest('Invalid query')
  }

  const allowed = new Set<string>([...options.columns, options.id])
  const filters = options.filters ?? {}

  const checkColumn = (column: string) => {
    if (!allowed.has(column)) {
      throw invalidColumn(column)
    }

    return column
  }

  const assertScalar = (key: string, value: unknown) => {
    if (Array.isArray(value) || isPlainObject(value)) {
      throw new BadRequest(`Invalid value for ${key}`)
    }
  }

  const parseColumn = (column: string, value: unknown): WhereNode[] => {
    checkColumn(column)

    if (value === null) {
      return [{ type: 'compare', column, operator: '=', value: null }]
    }

    if (isPlainObject(value)) {
      const entries = Object.entries(value)

      if (entries.length === 0) {
        throw new BadRequest(`Empty operator object for column '${column}'`)
      }

      return entries.map(([operator, operand]): WhereNode => {
        if (operator === '$in' || operator === '$nin') {
          const values = Array.isArray(operand) ? operand : [operand]

          if (values.includes(null)) {
            throw new BadRequest(`Operator ${operator} on column '${column}' does not accept null`)
          }

          values.forEach((item) => assertScalar(operator, item))

          return { type: 'in', column, values, negate: operator === '$nin' }
        }

        const comparison = has(COMPARISONS, operator) ? COMPARISONS[operator] : undefined

        if (!comparison) {
          throw invalidParameter(operator)
        }

        assertScalar(operator, operand)

        if (operand === null && comparison !== '<>') {
          throw new BadRequest(`Operator ${operator} on column '${column}' does not accept null`)
        }

        return { type: 'compare', column, operator: comparison, value: operand }
      })
    }

    if (Array.isArray(value)) {
      throw new BadRequest(`Invalid value for column '${column}'`)
    }

    return [{ type: 'compare', column, operator: '=', value }]
  }

  const parseGroup = (key: '$or' | '$and', value: unknown): WhereNode => {
    if (!Array.isArray(value)) {
      throw new BadRequest(`Invalid value for ${key}`)
    }

    if (value.length === 0) {
      throw new BadRequest(`${key} needs at least one condition`)
    }

    const nodes = value.map((item): WhereNode => {
      if (!isPlainObject(item) || Object.keys(item).length === 0) {
        throw new BadRequest(`Invalid value for ${key}`)
      }

      return { type: 'and', nodes: parseNested(item) }
    })

    return { type: key === '$or' ? 'or' : 'and', nodes }
  }

  // Conditions inside $or and $and: columns and further groups only.
  const parseNested = (object: Record<string, unknown>): WhereNode[] =>
    Object.entries(object).flatMap(([key, value]) => {
      if (key === '$or' || key === '$and') {
        return [parseGroup(key, value)]
      }

      if (key.startsWith('$')) {
        throw invalidParameter(key)
      }

      return parseColumn(key, value)
    })

  const result: SanitizedQuery = { sort: [] }
  const nodes: WhereNode[] = []
  let limit: unknown
  let skip: unknown

  for (const [key, original] of Object.entries(raw)) {
    if (!key.startsWith('$')) {
      nodes.push(...parseColumn(key, original))
      continue
    }

    if (!FILTER_KEYS.includes(key)) {
      throw invalidParameter(key)
    }

    const value = has(filters, key) ? filters[key](original, options) : original

    switch (key) {
      case '$or':
      case '$and':
        nodes.push(parseGroup(key, value))
        break
      case '$limit':
        limit = value
        break
      case '$skip':
        skip = value
        break
      case '$select': {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
          throw new BadRequest('Invalid value for $select')
        }

        const select = value.map(checkColumn)
        result.select = select.includes(options.id) ? select : [...select, options.id]
        break
      }
      case '$sort': {
        if (!isPlainObject(value)) {
          throw new BadRequest('Invalid value for $sort')
        }

        result.sort = Object.entries(value).map(([column, direction]) => {
          checkColumn(column)

          const order = typeof direction === 'string' ? Number(direction) : direction

          if (order !== 1 && order !== -1) {
            throw new BadRequest(`Invalid $sort value for column '${column}'`)
          }

          return { column, direction: order === 1 ? 'asc' : 'desc' }
        })
        break
      }
    }
  }

  if (nodes.length > 0) {
    result.where = { type: 'and', nodes }
  }

  result.limit = getLimit(parseNumber(limit), options.paginate)

  const parsedSkip = parseNumber(skip)
  result.skip = typeof parsedSkip === 'number' && !isNaN(parsedSkip) ? parsedSkip : undefined

  return result
}
