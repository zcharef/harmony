import { getApiErrorDetail } from './api-error'

const FALLBACK = 'Something went wrong'

describe('getApiErrorDetail', () => {
  it('returns detail for 403 Forbidden (owner cannot leave)', () => {
    const error = {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Server owner cannot leave. Transfer ownership first.',
    }
    expect(getApiErrorDetail(error, FALLBACK)).toBe(
      'Server owner cannot leave. Transfer ownership first.',
    )
  })

  it('returns detail for 400 Bad Request', () => {
    const error = {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'Channel name is required',
    }
    expect(getApiErrorDetail(error, FALLBACK)).toBe('Channel name is required')
  })

  it('returns detail for 409 Conflict', () => {
    const error = {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'User is already banned',
    }
    expect(getApiErrorDetail(error, FALLBACK)).toBe('User is already banned')
  })

  it('returns fallback for 500 Internal Server Error', () => {
    const error = {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An internal error occurred',
    }
    expect(getApiErrorDetail(error, FALLBACK)).toBe(FALLBACK)
  })

  it('returns fallback for 502 Bad Gateway', () => {
    const error = {
      type: 'about:blank',
      title: 'Bad Gateway',
      status: 502,
      detail: 'External service error',
    }
    expect(getApiErrorDetail(error, FALLBACK)).toBe(FALLBACK)
  })

  it('returns fallback for Error instance', () => {
    expect(getApiErrorDetail(new Error('Network failure'), FALLBACK)).toBe(FALLBACK)
  })

  it('returns fallback for plain string', () => {
    expect(getApiErrorDetail('something broke', FALLBACK)).toBe(FALLBACK)
  })

  it('returns fallback for null', () => {
    expect(getApiErrorDetail(null, FALLBACK)).toBe(FALLBACK)
  })

  it('returns fallback for undefined', () => {
    expect(getApiErrorDetail(undefined, FALLBACK)).toBe(FALLBACK)
  })

  it('returns fallback for empty object', () => {
    expect(getApiErrorDetail({}, FALLBACK)).toBe(FALLBACK)
  })

  it('returns fallback for object missing status field', () => {
    expect(getApiErrorDetail({ detail: 'some detail' }, FALLBACK)).toBe(FALLBACK)
  })
})
