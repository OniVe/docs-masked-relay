/**
 * Typed errors for the background router.
 *
 * Messages must stay constant and PII-free: they are returned to content
 * scripts/popup and may end up in bug reports. Never interpolate values from
 * the processed file, vault or key material here.
 */

import type { RelayFailureCode } from '../shared/messages';

export class RelayError extends Error {
  readonly code: RelayFailureCode;

  constructor(code: RelayFailureCode, message: string) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
  }
}
