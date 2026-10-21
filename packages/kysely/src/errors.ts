import {
  BadRequest,
  Conflict,
  FeathersError,
  Forbidden,
  GeneralError,
  Unavailable,
  Unprocessable
} from 'feathers/errors'

/** Symbol under which a mapped Feathers error keeps the original `pg` error. */
export const ERROR = Symbol.for('feathers/kysely/error')

interface PgError {
  code: string
  severity: string
  routine: string
  message: string
  detail?: string
}

function isPgError(error: unknown): error is PgError {
  const candidate = error as Partial<PgError> | null

  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.code === 'string' &&
    Boolean(candidate.severity) &&
    Boolean(candidate.routine)
  )
}

function isFeathersError(error: unknown): error is FeathersError {
  return error instanceof FeathersError || (error as FeathersError | null)?.type === 'FeathersError'
}

function createError(error: PgError): FeathersError {
  const { code } = error
  const message = error.detail || error.message

  if (code === '23505' || code === '23503') {
    return new Conflict(message)
  }

  if (code.startsWith('23') || code.startsWith('22')) {
    return new BadRequest(message)
  }

  if (code.startsWith('42')) {
    return new Unprocessable(message)
  }

  if (code.startsWith('28')) {
    return new Forbidden(message)
  }

  if (code.startsWith('08') || code === '57P03' || code === '53300' || code === '40001' || code === '40P01') {
    return new Unavailable(message)
  }

  return new GeneralError(message)
}

/**
 * Converts a database error into a Feathers error. A Feathers error passes
 * through unchanged. The original error stays reachable under `ERROR`.
 */
export function mapError(error: unknown): FeathersError {
  if (isFeathersError(error)) {
    return error
  }

  const mapped = isPgError(error)
    ? createError(error)
    : new GeneralError(error instanceof Error ? error.message : 'Unknown database error')

  Object.defineProperty(mapped, ERROR, { value: error, enumerable: false })

  return mapped
}
