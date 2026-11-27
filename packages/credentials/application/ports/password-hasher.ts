/**
 * Hashes passwords and verifies candidates. The application layer does not know the algorithm, so a
 * future algorithm migration is an adapter change (see docs/security/password-storage.md).
 */
export interface PasswordHasher {
  /**
   * Hashes a plaintext password into a self-describing string that encodes the algorithm,
   * parameters and salt, so old hashes stay verifiable after defaults change. A fresh random salt
   * per call means equal passwords never produce equal hashes.
   */
  hash(plaintext: string): Promise<string>;

  /**
   * Checks a candidate against a stored hash. Returns `false`, rather than throwing, for a wrong
   * password or a malformed or unreadable hash, so failures look identical to callers.
   */
  verify(plaintext: string, encodedHash: string): Promise<boolean>;

  /**
   * Whether `encodedHash` used weaker parameters than the current defaults. Login re-hashes when
   * this is true, since a successful login is the only time the plaintext is available.
   */
  needsRehash(encodedHash: string): boolean;
}
