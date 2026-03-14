import { describe, it, expect } from 'vitest'
import { safeTry } from './result.js'
import type { Result } from './result.js'

describe('safeTry', () => {
  it('resolves with [null, value] on success', async () => {
    const promise = Promise.resolve(42)
    const result: Result<number> = await safeTry(promise)

    expect(result).toEqual([null, 42])
    expect(result[0]).toBeNull()
    expect(result[1]).toBe(42)
  })

  it('resolves with [Error, null] on rejection', async () => {
    const error = new Error('test error')
    const promise = Promise.reject(error)
    const result: Result<number> = await safeTry(promise)

    expect(result[0]).toBe(error)
    expect(result[1]).toBeNull()
    expect(result[0]?.message).toBe('test error')
  })

  it('handles async functions that throw', async () => {
    const asyncFn = async (): Promise<string> => {
      throw new TypeError('type error')
    }
    const result = await safeTry(asyncFn())

    expect(result[0]).toBeInstanceOf(TypeError)
    expect(result[1]).toBeNull()
  })

  it('preserves the resolved type', async () => {
    const result = await safeTry(Promise.resolve({ name: 'test', count: 5 }))

    expect(result[0]).toBeNull()
    expect(result[1]).toEqual({ name: 'test', count: 5 })
  })
})
