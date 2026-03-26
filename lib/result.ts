export type Success<T> = { ok: true; value: T }
export type Failure = { ok: false; error: string; code?: number }
export type Result<T> = Success<T> | Failure

export function success<T>(value: T): Success<T> {
  return { ok: true, value }
}

export function failure(error: string, code?: number): Failure {
  return { ok: false, error, code }
}

export function isSuccess<T>(result: Result<T>): result is Success<T> {
  return result.ok === true
}

export function isFailure<T>(result: Result<T>): result is Failure {
  return result.ok === false
}
