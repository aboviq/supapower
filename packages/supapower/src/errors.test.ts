import { describe, expect, test } from 'bun:test';

import {
  asSupapowerError,
  isSupapowerError,
  isUnrecoverableUploadError,
  SupapowerError,
} from './errors.js';

describe('SupapowerError', () => {
  test('keeps the code and the cause', () => {
    const cause = new Error('socket hang up');
    const error = new SupapowerError('Could not reach Supabase', {
      code: 'connection_failed',
      cause,
    });

    expect(error.code).toBe('connection_failed');
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('Could not reach Supabase');
    expect(error.name).toBe('SupapowerError');
  });

  test('is an Error', () => {
    const error = new SupapowerError('Not initialized', { code: 'not_initialized' });

    expect(error).toBeInstanceOf(Error);
  });
});

describe('isSupapowerError', () => {
  test('accepts a SupapowerError', () => {
    expect(isSupapowerError(new SupapowerError('boom', { code: 'upload_failed' }))).toBe(true);
  });

  test('rejects anything else', () => {
    expect(isSupapowerError(new Error('boom'))).toBe(false);
    expect(isSupapowerError('boom')).toBe(false);
    expect(isSupapowerError(null)).toBe(false);
  });
});

const uploadError = (code: string) =>
  new SupapowerError('rejected', { code: 'upload_failed', cause: { code, message: code } });

describe('isUnrecoverableUploadError', () => {
  test('accepts the Postgres classes that never succeed on a retry', () => {
    expect(isUnrecoverableUploadError(uploadError('22001'))).toBe(true); // data exception
    expect(isUnrecoverableUploadError(uploadError('23505'))).toBe(true); // unique violation
    expect(isUnrecoverableUploadError(uploadError('23503'))).toBe(true); // foreign key
    expect(isUnrecoverableUploadError(uploadError('42501'))).toBe(true); // RLS denial
  });

  test('rejects transient failures', () => {
    expect(isUnrecoverableUploadError(uploadError('08006'))).toBe(false); // connection failure
    expect(isUnrecoverableUploadError(uploadError('57014'))).toBe(false); // query cancelled
    expect(isUnrecoverableUploadError(new Error('Failed to fetch'))).toBe(false);
    expect(isUnrecoverableUploadError(undefined)).toBe(false);
  });

  test('reads the response code, not Supapower’s own error code', () => {
    const error = new SupapowerError('not configured', { code: 'schema_mismatch' });

    expect(isUnrecoverableUploadError(error)).toBe(false);
  });

  test('ignores a code that is not a string', () => {
    expect(isUnrecoverableUploadError({ code: 23_505 })).toBe(false);
  });
});

describe('asSupapowerError', () => {
  test('wraps an unknown failure, keeping it as the cause', () => {
    const cause = new TypeError('fetch failed');

    const error = asSupapowerError(cause, 'The outgoing sync failed', 'upload_failed');

    expect(error).toBeInstanceOf(SupapowerError);
    expect(error.code).toBe('upload_failed');
    expect(error.message).toBe('The outgoing sync failed');
    expect(error.cause).toBe(cause);
  });

  test('wraps a thrown value that is not an Error at all', () => {
    const error = asSupapowerError('boom', 'Could not apply a remote change', 'apply_failed');

    expect(error.code).toBe('apply_failed');
    expect(error.cause).toBe('boom');
  });

  test('wraps nothing at all, so a callback still gets a code', () => {
    const error = asSupapowerError(undefined, 'Realtime went quiet', 'connection_failed');

    expect(error.code).toBe('connection_failed');
    expect(error.cause).toBeUndefined();
  });

  test('passes a SupapowerError through, keeping its own code', () => {
    const original = new SupapowerError('Could not download', { code: 'download_failed' });

    const error = asSupapowerError(original, 'The outgoing sync failed', 'upload_failed');

    expect(error).toBe(original);
    expect(error.code).toBe('download_failed');
  });
});
