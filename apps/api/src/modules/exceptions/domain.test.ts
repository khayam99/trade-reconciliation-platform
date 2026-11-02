import { describe, expect, it } from 'vitest';
import { assertExceptionTransition, validateReason } from './domain.js';
import { ExceptionServiceError } from './errors.js';

describe('exception resolution domain rules', () => {
  it.each(['open', 'investigating'] as const)('allows resolving %s exceptions', (status) => {
    expect(() => assertExceptionTransition(status, 'resolve')).not.toThrow();
  });

  it('allows reopening resolved exceptions only', () => {
    expect(() => assertExceptionTransition('resolved', 'reopen')).not.toThrow();
    expect(() => assertExceptionTransition('open', 'reopen')).toThrow(ExceptionServiceError);
    expect(() => assertExceptionTransition('investigating', 'reopen')).toThrow(
      ExceptionServiceError,
    );
    expect(() => assertExceptionTransition('ignored', 'reopen')).toThrow(ExceptionServiceError);
  });

  it('rejects resolving resolved and ignored exceptions', () => {
    expect(() => assertExceptionTransition('resolved', 'resolve')).toThrow(ExceptionServiceError);
    expect(() => assertExceptionTransition('ignored', 'resolve')).toThrow(ExceptionServiceError);
  });

  it('trims valid reasons and enforces the maximum after trimming', () => {
    expect(validateReason('  reviewed  ')).toBe('reviewed');
    expect(validateReason(` ${'x'.repeat(1_000)} `)).toHaveLength(1_000);
    expect(() => validateReason('x'.repeat(1_001))).toThrow(ExceptionServiceError);
  });

  it.each([undefined, null, 12, '', '  \t  '])('rejects invalid reason %s', (reason) => {
    expect(() => validateReason(reason)).toThrow(ExceptionServiceError);
  });
});
