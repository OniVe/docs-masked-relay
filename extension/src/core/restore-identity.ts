/**
 * Restore identity errors (R16-RESTORE-IDENTITY).
 *
 * A masked download can be restored only when the vault record that produced
 * it is unambiguous. When the name is shared and the masked bytes do not
 * identify one record, the adapter throws this error and the caller leaves
 * the download masked instead of replaying another file's occurrences.
 */

export class AmbiguousVaultFileError extends Error {
  readonly code = 'AMBIGUOUS_VAULT_FILE' as const;

  constructor(reason: string) {
    super(`AMBIGUOUS_VAULT_FILE: ${reason}`);
    this.name = 'AmbiguousVaultFileError';
  }
}

/**
 * The masked bytes hash to no vault record while the file name belongs to a
 * hashed record (modified or foreign bytes), or neither the hash nor the name
 * identifies a record. Restoring any record in that case would replay one
 * file's occurrences into another, so the caller leaves the download masked.
 */
export class IdentityMismatchVaultFileError extends Error {
  readonly code = 'VAULT_FILE_IDENTITY_MISMATCH' as const;

  constructor(reason: string) {
    super(`VAULT_FILE_IDENTITY_MISMATCH: ${reason}`);
    this.name = 'IdentityMismatchVaultFileError';
  }
}
