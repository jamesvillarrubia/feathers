import type {
  Expression,
  ExpressionBuilder,
  Insertable,
  Kysely,
  Selectable,
  SqlBool,
  Transaction,
  Updateable
} from 'kysely'
import { sql } from 'kysely'
import type {
  Application,
  HookContext,
  Id,
  NextFunction,
  Paginated,
  PaginationParams,
  Params,
  Query
} from 'feathers'
import { BadRequest, MethodNotAllowed, NotFound } from 'feathers/errors'
import { mapError } from './errors.js'
import { COLUMN_OPERATORS, FILTER_KEYS, sanitizeQuery } from './query.js'
import type { SanitizedQuery, WhereNode } from './query.js'

export { ERROR, mapError } from './errors.js'
export { getLimit, sanitizeQuery } from './query.js'
export type { SanitizedQuery, WhereNode } from './query.js'

type MultiMethod = 'create' | 'patch' | 'remove'

export interface KyselyServiceOptions<DB, TB extends keyof DB & string> {
  db: Kysely<DB>
  table: TB
  schema?: string
  /** Primary key column. Default `'id'`. */
  id?: keyof DB[TB] & string
  /** The only column names a query may reference. The id column is always accepted. */
  columns: readonly (keyof DB[TB] & string)[]
  paginate?: PaginationParams
  multi?: boolean | MultiMethod[]
  events?: string[]
  /**
   * Operator names the adapter accepts. It translates only its own column
   * operators, so the constructor throws for any other entry.
   */
  operators?: string[]
  /** Transforms the value of a built-in `$` key ($limit, $skip, $sort, $select, $or, $and). */
  filters?: Record<string, (value: unknown, options: KyselyServiceOptions<DB, TB>) => unknown>
}

export interface KyselyParams<Q = Query> extends Params<Q> {
  transaction?: Transaction<any>
  adapter?: Partial<Pick<KyselyServiceOptions<any, any>, 'paginate' | 'multi' | 'table' | 'schema' | 'id'>>
}

export type KyselyFindParams<Q = Query> = KyselyParams<Q> & { paginate?: PaginationParams }

// Kysely cannot type a table that is only known at runtime, so queries are built against `any`.
type AnyDb = Kysely<any>
type AnyBuilder = ExpressionBuilder<any, any>

interface ResolvedOptions extends KyselyServiceOptions<any, any> {
  id: string
  paginate: PaginationParams
  multi: boolean | MultiMethod[]
}

function allowsMulti(method: MultiMethod, options: ResolvedOptions) {
  const { multi } = options

  return multi === true || (Array.isArray(multi) && multi.includes(method))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toExpression(eb: AnyBuilder, node: WhereNode): Expression<SqlBool> {
  switch (node.type) {
    case 'and':
      return eb.and(node.nodes.map((child) => toExpression(eb, child)))
    case 'or':
      return eb.or(node.nodes.map((child) => toExpression(eb, child)))
    case 'in':
      if (node.values.length === 0) {
        return node.negate ? sql<SqlBool>`true` : sql<SqlBool>`false`
      }

      return eb(eb.ref(node.column), node.negate ? 'not in' : 'in', node.values)
    case 'compare':
      if (node.value === null) {
        return eb(eb.ref(node.column), node.operator === '<>' ? 'is not' : 'is', null)
      }

      return eb(eb.ref(node.column), node.operator, node.value)
  }
}

class Context {
  readonly options: ResolvedOptions
  readonly executor: AnyDb
  readonly query: SanitizedQuery

  constructor(base: KyselyServiceOptions<any, any>, params: KyselyFindParams) {
    const paginate = params.paginate !== undefined ? params.paginate : base.paginate

    this.options = { ...base, paginate, ...params.adapter } as ResolvedOptions
    this.executor = params.transaction ?? this.options.db
    this.query = sanitizeQuery(params.query, { ...this.options })
  }

  get table(): string {
    return this.options.table
  }

  get scoped(): AnyDb {
    const { schema } = this.options

    return schema ? this.executor.withSchema(schema) : this.executor
  }

  /** SELECT for the sanitised `$select`, or every column. Column names passed the `columns` whitelist. */
  selectFrom() {
    const rows = this.scoped.selectFrom(this.table)
    const { select } = this.query

    return select ? rows.select(select.map((column) => `${this.table}.${column}`)) : rows.selectAll()
  }

  /** WHERE clause for the sanitised query, optionally pinned to one id. */
  where(id?: Id | null) {
    const { where } = this.query
    const idColumn = this.options.id

    return (eb: AnyBuilder) => {
      const parts: Expression<SqlBool>[] = []

      if (id !== undefined && id !== null) {
        parts.push(eb(eb.ref(idColumn), '=', id))
      }

      if (where) {
        parts.push(toExpression(eb, where))
      }

      return eb.and(parts)
    }
  }
}

function notFound(id: Id) {
  return new NotFound(`No record found for id '${id}'`)
}

export class KyselyService<
  DB,
  TB extends keyof DB & string,
  Result = Selectable<DB[TB]>,
  Data = Insertable<DB[TB]>,
  PatchData = Updateable<DB[TB]>
> {
  options: KyselyServiceOptions<DB, TB>

  constructor(options: KyselyServiceOptions<DB, TB>) {
    if (!options || !options.db) {
      throw new Error('You must provide a Kysely instance as db')
    }

    if (typeof options.table !== 'string') {
      throw new Error('No table name specified.')
    }

    if (!Array.isArray(options.columns)) {
      throw new Error('You must provide a columns list')
    }

    for (const operator of options.operators ?? []) {
      if (!COLUMN_OPERATORS.includes(operator) && operator !== '$or' && operator !== '$and') {
        throw new Error(`Operator ${operator} cannot be translated to SQL by the Kysely adapter`)
      }
    }

    for (const key of Object.keys(options.filters ?? {})) {
      if (!FILTER_KEYS.includes(key)) {
        throw new Error(
          `Filter ${key} is not consumed by the Kysely adapter; it can only transform ${FILTER_KEYS.join(', ')}`
        )
      }
    }

    this.options = {
      id: 'id' as keyof DB[TB] & string,
      events: [],
      paginate: false,
      multi: false,
      filters: {},
      operators: [],
      ...options
    }
  }

  get id(): string {
    return this.options.id as string
  }

  get events(): string[] {
    return this.options.events ?? []
  }

  find(params: KyselyParams & { paginate: false }): Promise<Result[]>
  find(params?: KyselyFindParams): Promise<Paginated<Result> | Result[]>
  async find(params: KyselyFindParams = {}): Promise<Paginated<Result> | Result[]> {
    try {
      const context = new Context(this.options, params)
      const { query, options } = context
      const paginated = Boolean(options.paginate && options.paginate.default)

      if (query.limit === 0 && !paginated) {
        return []
      }

      const selectRows = async (): Promise<Result[]> => {
        if (query.limit === 0) {
          return []
        }

        let rows = context.selectFrom().where(context.where())

        for (const { column, direction } of query.sort) {
          rows = rows.orderBy((eb: AnyBuilder) => eb.ref(column), direction)
        }

        if (query.limit !== undefined) {
          rows = rows.limit(query.limit)
        }

        if (query.skip !== undefined) {
          rows = rows.offset(query.skip)
        }

        return rows.execute() as Promise<Result[]>
      }

      const countRows = async (): Promise<number> => {
        const row = await context.scoped
          .selectFrom(context.table)
          .select((eb: AnyBuilder) => eb.fn.countAll().as('total'))
          .where(context.where())
          .executeTakeFirstOrThrow()

        // pg returns count(*) as a bigint string
        return Number(row.total)
      }

      if (!paginated) {
        return await selectRows()
      }

      const [total, data] = await Promise.all([countRows(), selectRows()])

      return { total, limit: query.limit!, skip: query.skip || 0, data }
    } catch (error) {
      throw mapError(error)
    }
  }

  async get(id: Id, params: KyselyParams = {}): Promise<Result> {
    try {
      const context = new Context(this.options, params)

      if (id === undefined || (id as Id | null) === null) {
        throw new BadRequest('An id is required for get')
      }

      const row = await context.selectFrom().where(context.where(id)).executeTakeFirst()

      if (!row) {
        throw notFound(id)
      }

      return row as Result
    } catch (error) {
      throw mapError(error)
    }
  }

  create(data: Data[], params?: KyselyParams): Promise<Result[]>
  create(data: Data, params?: KyselyParams): Promise<Result>
  async create(data: Data | Data[], params: KyselyParams = {}): Promise<Result | Result[]> {
    try {
      const context = new Context(this.options, params)
      const multi = Array.isArray(data)

      if (multi && !allowsMulti('create', context.options)) {
        throw new MethodNotAllowed('Can not create multiple entries')
      }

      const items: unknown[] = multi ? data : [data]

      if (items.some((item) => !isRecord(item))) {
        throw new BadRequest('Create data must be an object or an array of objects')
      }

      if (items.length === 0) {
        return []
      }

      const rows = items as Record<string, unknown>[]
      const isEmpty = (row: Record<string, unknown>) =>
        Object.values(row).every((value) => value === undefined)
      const { select } = context.query
      const insertOne = async (executor: AnyDb, row: Record<string, unknown>) => {
        const insert = executor.insertInto(context.table)
        const values = isEmpty(row) ? insert.defaultValues() : insert.values(row)

        return (select ? values.returning(select) : values.returningAll()).executeTakeFirstOrThrow()
      }

      if (!multi) {
        return (await insertOne(context.scoped, rows[0])) as Result
      }

      if (!rows.some(isEmpty)) {
        const values = context.scoped.insertInto(context.table).values(rows)

        return (await (select ? values.returning(select) : values.returningAll()).execute()) as Result[]
      }

      // A row with no values needs DEFAULT VALUES, which a multi-row VALUES list cannot express.
      // Insert row by row, in order, inside one transaction (or the caller's).
      const insertAll = async (executor: AnyDb) => {
        const inserted: unknown[] = []

        for (const row of rows) {
          inserted.push(
            await insertOne(
              context.options.schema ? executor.withSchema(context.options.schema) : executor,
              row
            )
          )
        }

        return inserted as Result[]
      }

      return params.transaction
        ? await insertAll(params.transaction)
        : await context.options.db.transaction().execute((trx: AnyDb) => insertAll(trx))
    } catch (error) {
      throw mapError(error)
    }
  }

  async update(id: Id, data: Data, params: KyselyParams = {}): Promise<Result> {
    try {
      const context = new Context(this.options, params)

      if (id === undefined || (id as Id | null) === null) {
        throw new BadRequest("You can not replace multiple instances. Did you mean 'patch'?")
      }

      if (!isRecord(data)) {
        throw new BadRequest('Update data must be an object')
      }

      const idColumn = context.options.id
      const missing = context.options.columns.filter(
        (column: string) => column !== idColumn && data[column] === undefined
      )

      if (missing.length > 0) {
        throw new BadRequest(
          `update replaces the whole row; missing columns: ${missing.join(', ')}. Use patch for a partial write.`
        )
      }

      const { [idColumn]: _id, ...values } = data
      const update = context.scoped.updateTable(context.table).set(values).where(context.where(id))
      const row = await (
        context.query.select ? update.returning(context.query.select) : update.returningAll()
      ).executeTakeFirst()

      if (!row) {
        throw notFound(id)
      }

      return row as Result
    } catch (error) {
      throw mapError(error)
    }
  }

  patch(id: Id, data: PatchData, params?: KyselyParams): Promise<Result>
  patch(id: null, data: PatchData, params?: KyselyParams): Promise<Result[]>
  async patch(id: Id | null, data: PatchData, params: KyselyParams = {}): Promise<Result | Result[]> {
    try {
      const context = new Context(this.options, params)
      const { query } = context

      id = id ?? null

      if (id === null && !allowsMulti('patch', context.options)) {
        throw new MethodNotAllowed('Can not patch multiple entries')
      }

      if (!isRecord(data)) {
        throw new BadRequest('Patch data must be an object')
      }

      const { [context.options.id]: _id, ...rest } = data
      const values = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined))

      if (Object.keys(values).length === 0) {
        // Nothing to write: return the current row or rows
        const rows = await context.selectFrom().where(context.where(id)).execute()

        return this.single(id, rows) as Result | Result[]
      }

      const update = context.scoped.updateTable(context.table).set(values).where(context.where(id))
      const rows = await (query.select ? update.returning(query.select) : update.returningAll()).execute()

      return this.single(id, rows) as Result | Result[]
    } catch (error) {
      throw mapError(error)
    }
  }

  remove(id: Id, params?: KyselyParams): Promise<Result>
  remove(id: null, params?: KyselyParams): Promise<Result[]>
  async remove(id: Id | null, params: KyselyParams = {}): Promise<Result | Result[]> {
    try {
      const context = new Context(this.options, params)
      const { query } = context

      id = id ?? null

      if (id === null && !allowsMulti('remove', context.options)) {
        throw new MethodNotAllowed('Can not remove multiple entries')
      }

      const del = context.scoped.deleteFrom(context.table).where(context.where(id))
      const rows = await (query.select ? del.returning(query.select) : del.returningAll()).execute()

      return this.single(id, rows) as Result | Result[]
    } catch (error) {
      throw mapError(error)
    }
  }

  /** Array for a multi call, the first row or NotFound for a single id. */
  private single(id: Id | null, rows: unknown[]) {
    if (id === null) {
      return rows
    }

    if (rows.length === 0) {
      throw notFound(id)
    }

    return rows[0]
  }
}

/**
 * Runs `fn` in a database transaction. Pass `{ transaction: trx }` in the
 * params of every service call that should take part. The transaction commits
 * when `fn` resolves and rolls back when it throws.
 */
export function withTransaction<DB, T>(
  _app: Application,
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(fn)
}

/**
 * An `around` hook that opens a transaction, sets `params.transaction` and
 * lets Kysely commit on return or roll back on throw. A call that already
 * carries `params.transaction` joins it.
 */
export function transaction<DB>(db: Kysely<DB>) {
  return async (context: HookContext, next: NextFunction): Promise<void> => {
    if ((context.params as KyselyParams).transaction) {
      return next()
    }

    try {
      await db.transaction().execute(async (trx) => {
        context.params = { ...context.params, transaction: trx } as KyselyParams
        await next()
      })
    } finally {
      const { transaction: _closed, ...params } = context.params as KyselyParams
      context.params = params
    }
  }
}
