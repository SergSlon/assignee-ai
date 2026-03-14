import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log, LOG_ACTIONS } from './logger.js'
import type { LogEvent } from './logger.js'

describe('logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('writes valid JSON to stderr', () => {
    const event: LogEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      runId: '00000000-0000-0000-0000-000000000001',
      level: 'info',
      action: LOG_ACTIONS.PLAN_STARTED,
    }

    log(event)

    expect(stderrSpy).toHaveBeenCalledOnce()
    const written = stderrSpy.mock.calls[0]?.[0] as string
    expect(() => JSON.parse(written)).not.toThrow()
  })

  it('outputs all required LogEvent fields', () => {
    const event: LogEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      runId: '00000000-0000-0000-0000-000000000002',
      level: 'error',
      action: LOG_ACTIONS.APPLY_FAILED,
      durationMs: 1240,
      result: 'FAILED',
    }

    log(event)

    const written = stderrSpy.mock.calls[0]?.[0] as string
    const parsed = JSON.parse(written) as Record<string, unknown>

    expect(parsed['ts']).toBe('2026-01-01T00:00:00.000Z')
    expect(parsed['runId']).toBe('00000000-0000-0000-0000-000000000002')
    expect(parsed['level']).toBe('error')
    expect(parsed['action']).toBe('apply_failed')
    expect(parsed['durationMs']).toBe(1240)
    expect(parsed['result']).toBe('FAILED')
  })

  it('writes single-line JSON (no pretty-printing)', () => {
    const event: LogEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      runId: '00000000-0000-0000-0000-000000000003',
      level: 'info',
      action: LOG_ACTIONS.SCHEMA_FETCHED,
    }

    log(event)

    const written = stderrSpy.mock.calls[0]?.[0] as string
    // Should be exactly one line (JSON + newline)
    const lines = written.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
  })

  it('LOG_ACTIONS contains expected action names', () => {
    expect(LOG_ACTIONS.PLAN_STARTED).toBe('plan_started')
    expect(LOG_ACTIONS.APPLY_SUCCEEDED).toBe('apply_succeeded')
    expect(LOG_ACTIONS.APPLY_FAILED).toBe('apply_failed')
    expect(LOG_ACTIONS.PLAN_REJECTED).toBe('plan_rejected_by_user')
  })
})
