class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', cause } = {}) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    if (cause) {
      this.cause = cause
    }
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Bad request', options = {}) {
    super(message, { status: 400, code: 'bad_request', ...options })
    this.name = 'BadRequestError'
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', options = {}) {
    super(message, { status: 403, code: 'forbidden', ...options })
    this.name = 'ForbiddenError'
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found', options = {}) {
    super(message, { status: 404, code: 'not_found', ...options })
    this.name = 'NotFoundError'
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict', options = {}) {
    super(message, { status: 409, code: 'conflict', ...options })
    this.name = 'ConflictError'
  }
}

module.exports = {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
}
