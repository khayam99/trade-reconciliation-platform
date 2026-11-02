import { describe, expect, it } from 'vitest';
import {
  auditStatusChange,
  availableExceptionAction,
  displayValidationError,
  exceptionMutationErrorMessage,
  validateExceptionReason,
} from './exceptionManagement';

describe('exception management UI rules', () => {
  it('offers the supported action for each status', () => {
    expect(availableExceptionAction('open')).toBe('resolve');
    expect(availableExceptionAction('investigating')).toBe('resolve');
    expect(availableExceptionAction('resolved')).toBe('reopen');
    expect(availableExceptionAction('ignored')).toBeNull();
  });

  it('trims reasons and enforces a required 1000-character maximum', () => {
    expect(validateExceptionReason('  checked  ')).toEqual({ reason: 'checked' });
    expect(validateExceptionReason('  ')).toEqual({ error: 'Enter a reason before continuing.' });
    expect(validateExceptionReason('x'.repeat(1_000)).reason).toHaveLength(1_000);
    expect(validateExceptionReason(`  ${'x'.repeat(1_000)}  `).reason).toHaveLength(1_000);
    expect(validateExceptionReason('x'.repeat(1_001))).toEqual({
      error: 'Reason must be 1,000 characters or fewer.',
    });
  });

  it('formats status changes and validation issue details safely', () => {
    expect(auditStatusChange({ previousStatus: 'open', newStatus: 'resolved' })).toBe(
      'open → resolved',
    );
    expect(auditStatusChange({})).toBeNull();
    expect(displayValidationError('Invalid row')).toBe('Invalid row');
    expect(
      displayValidationError({ field: 'price', code: 'INVALID_DECIMAL', message: 'Required.' }),
    ).toBe('price: Required. (INVALID_DECIMAL)');
  });

  it('uses safe user-facing messages for failed API mutations', () => {
    expect(exceptionMutationErrorMessage(new Error('Failed to fetch'))).toBe(
      'Could not save this exception. Check your connection and try again.',
    );
  });
});
