// Curated public surface of @verixa/stellar-anchor. See
// docs/guides/stellar-anchoring.md and docs/adr/0003-stellar-audit-anchoring.md.

// The port and its types — what consumers depend on. Nothing here mentions
// Stellar, so a consumer can be written (and tested) against anchoring in
// general, then wired to a specific ledger at composition time.
export { AnchorError, isValidSha256Hex } from "./application/ports/hash-anchor.js";
export type { AnchorReceipt, HashAnchor } from "./application/ports/hash-anchor.js";

// Signing. `TransactionSigner` is the boundary that keeps the anchoring
// account's key out of this process; the adapters below are the two ways across
// it. See docs/security/stellar-key-management.md.
export { SigningError } from "./application/ports/transaction-signer.js";
export type { TransactionSigner } from "./application/ports/transaction-signer.js";
export {
  KmsTransactionSigner,
  type KmsSignClient,
  type KmsSignRequest,
  type KmsTransactionSignerOptions,
} from "./infrastructure/signing/kms-transaction-signer.js";
export { LocalTransactionSigner } from "./infrastructure/signing/local-transaction-signer.js";
// Funding monitoring: the balance port, its metric and alert shapes, and the
// stroop arithmetic. The monitor itself stays out — see below.
export {
  ANCHOR_TRANSACTION_FEE_STROOPS,
  BalanceUnavailableError,
  NullAnchorBalanceMetricSink,
  STROOPS_PER_XLM,
  stroopsToXlm,
  xlmToStroops,
} from "./application/ports/account-balance.js";
export type {
  AnchorAccountBalance,
  AnchorAccountBalanceReader,
  AnchorBalanceMetric,
  AnchorBalanceMetricSink,
  AnchorFundingAlert,
  AnchorFundingAlertKind,
  AnchorFundingAlerter,
  AnchorFundingGuard,
} from "./application/ports/account-balance.js";

// The Stellar adapter.
export { StellarHashAnchor } from "./infrastructure/stellar/stellar-hash-anchor.js";
export type {
  StellarHashAnchorOptions,
  StellarNetwork,
} from "./infrastructure/stellar/stellar-hash-anchor.js";

// Test doubles, exported deliberately: consumers testing their own anchoring
// logic need them, and the in-memory anchor doubles as the "anchoring disabled"
// implementation for deployments that want no ledger dependency at all.
// Funding monitoring against a real Horizon. Exported because an operator
// wiring a deployment needs both halves: the reader that talks to the ledger
// and the monitor that decides when to shout.
export {
  AnchorBalanceMonitor,
  DEFAULT_BALANCE_THRESHOLD_XLM,
  HorizonAccountBalanceReader,
  isUnderfundedLedgerError,
  loggingFundingAlerter,
} from "./infrastructure/balance-monitor.js";
export type {
  AnchorBalanceMonitorOptions,
  AnchorFundingStatus,
  StructuredErrorLogger,
} from "./infrastructure/balance-monitor.js";

// Test double, exported deliberately: consumers testing their own anchoring
// logic need it, and it doubles as the "anchoring disabled" implementation
// for deployments that want no ledger dependency at all.
export { InMemoryHashAnchor } from "./infrastructure/testing/in-memory-hash-anchor.js";
export {
  fakeKmsClient,
  type FakeKmsClient,
} from "./infrastructure/testing/fake-kms-sign-client.js";

// `hashAnchorContract` is not exported here: it imports `vitest`, and loading vitest in a
// production process crashes it at startup. Consumers import it by relative path; expose it through
// a `./testing` subpath export if an external implementation needs it.
