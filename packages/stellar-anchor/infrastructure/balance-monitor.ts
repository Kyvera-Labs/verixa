import { Horizon } from "@stellar/stellar-sdk";
import { Result } from "@verixa/shared-kernel";

import {
  ANCHOR_TRANSACTION_FEE_STROOPS,
  BalanceUnavailableError,
  type AnchorBalanceMetricSink,
  type AnchorFundingAlerter,
  type AnchorFundingAlert,
  type AnchorFundingAlertKind,
  type AnchorFundingGuard,
  type AnchorAccountBalance,
  type AnchorAccountBalanceReader,
  NullAnchorBalanceMetricSink,
  STROOPS_PER_XLM,
  stroopsToXlm,
  xlmToStroops,
} from "../application/ports/account-balance.js";
import { AnchorError } from "../application/ports/hash-anchor.js";

/** Horizon endpoints per network, shared with the anchoring adapter. */
const HORIZON_URLS: Readonly<Record<"testnet" | "public", string>> = {
  testnet: "https://horizon-testnet.stellar.org",
  public: "https://horizon.stellar.org",
};

/**
 * Reads the anchoring account's balance over Horizon.
 *
 * `loadAccount` rather than a raw ledger query because it is the same call
 * the adapter already makes to build a transaction: if this account is not
 * loadable, anchoring is not loadable either, and the monitor then agrees with
 * the thing it is monitoring rather than reporting a healthy account the
 * adapter cannot use.
 */
export class HorizonAccountBalanceReader implements AnchorAccountBalanceReader {
  readonly #server: Horizon.Server;
  readonly #networkId: string;

  constructor(options: { network: "testnet" | "public"; horizonUrl?: string | undefined }) {
    this.#server = new Horizon.Server(options.horizonUrl ?? HORIZON_URLS[options.network]);
    this.#networkId = `stellar:${options.network}`;
  }

  async read(publicKey: string): Promise<Result<AnchorAccountBalance, BalanceUnavailableError>> {
    let balance: string | undefined;

    try {
      const account = await this.#server.loadAccount(publicKey);
      const native = account.balances.find((asset) => asset.asset_type === "native");
      balance = native?.balance;
    } catch (error) {
      return Result.err(
        new BalanceUnavailableError(
          `Could not read the balance of ${publicKey}: ${describeError(error)}`,
          { cause: error },
        ),
      );
    }

    if (balance === undefined) {
      return Result.err(
        new BalanceUnavailableError(`Account ${publicKey} has no native (XLM) balance line.`),
      );
    }

    const stroops = xlmToStroops(balance);
    if (stroops === undefined) {
      return Result.err(
        new BalanceUnavailableError(
          `Horizon reported an unparseable XLM balance for ${publicKey}: "${balance}".`,
        ),
      );
    }

    return Result.ok({
      publicKey,
      network: this.#networkId,
      availableStroops: stroops,
      queriedAt: new Date(),
    });
  }
}

/** What a funding check concluded, and the numbers behind it. */
export type AnchorFundingStatus =
  | { readonly kind: "funded"; readonly balance: AnchorAccountBalance }
  | { readonly kind: "below_threshold"; readonly balance: AnchorAccountBalance }
  | { readonly kind: "unfundable"; readonly balance: AnchorAccountBalance }
  | { readonly kind: "unknown"; readonly error: BalanceUnavailableError };

export interface AnchorBalanceMonitorOptions {
  readonly reader: AnchorAccountBalanceReader;
  /** The anchoring account, in `G...` form. Safe to publish — it is how anyone finds the anchor history. */
  readonly publicKey: string;
  /** Alert once the balance drops below this. Defaults to {@link DEFAULT_BALANCE_THRESHOLD_XLM}. */
  readonly thresholdXlm?: number | undefined;
  /** Fee a single anchoring transaction pays, in stroops. */
  readonly transactionFeeStroops?: number | undefined;
  readonly alerter: AnchorFundingAlerter;
  readonly metricSink?: AnchorBalanceMetricSink | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * One XLM: enough for 10,000 anchoring transactions at the base fee, which on
 * an hourly schedule is more than a year of headroom. High enough that a
 * deployment that has simply forgotten to fund the account is caught early,
 * low enough that it will never page anyone over normal operation.
 */
export const DEFAULT_BALANCE_THRESHOLD_XLM = 1;

/**
 * Watches the anchoring account's funding and alerts before it runs out. When the account is empty
 * the ledger refuses anchors, and without monitoring the audit log silently stops being anchored.
 *
 * An unreadable balance is reported as `unknown` and alerts on first occurrence, since not knowing
 * is not the same as fine. Metrics are emitted on every check, but an alert fires once per
 * low-balance episode; `recovered` resets it so a later drop alerts again.
 */
export class AnchorBalanceMonitor implements AnchorFundingGuard {
  readonly #reader: AnchorAccountBalanceReader;
  readonly #publicKey: string;
  readonly #thresholdStroops: number;
  readonly #feeStroops: number;
  readonly #alerter: AnchorFundingAlerter;
  readonly #metrics: AnchorBalanceMetricSink;
  readonly #now: () => Date;

  /** The last kind alerted, cleared when the account recovers. See the deduplication note. */
  #lastAlertedKind: AnchorFundingAlertKind | undefined;
  /** Set from a ledger rejection, which outranks the cached reading until a poll sees funds again. */
  #reportedUnderfunded = false;
  #lastStatus: AnchorFundingStatus | undefined;

  constructor(options: AnchorBalanceMonitorOptions) {
    this.#reader = options.reader;
    this.#publicKey = options.publicKey;
    this.#thresholdStroops = Math.round(
      (options.thresholdXlm ?? DEFAULT_BALANCE_THRESHOLD_XLM) * STROOPS_PER_XLM,
    );
    this.#feeStroops = options.transactionFeeStroops ?? ANCHOR_TRANSACTION_FEE_STROOPS;
    this.#alerter = options.alerter;
    this.#metrics = options.metricSink ?? NullAnchorBalanceMetricSink;
    this.#now = options.now ?? (() => new Date());
  }

  /** The configured alert level, in XLM. */
  get thresholdXlm(): number {
    return stroopsToXlm(this.#thresholdStroops);
  }

  /** The most recent check, without performing a new one. `undefined` until the first. */
  get lastStatus(): AnchorFundingStatus | undefined {
    return this.#lastStatus;
  }

  /**
   * Reads the balance, emits the metric, and raises an alert if the funding
   * state has changed in a way an operator needs to know about.
   */
  async check(): Promise<AnchorFundingStatus> {
    const reading = await this.#reader.read(this.#publicKey);

    if (Result.isErr(reading)) {
      const status: AnchorFundingStatus = { kind: "unknown", error: reading.error };
      this.#lastStatus = status;
      this.#emitMetric(undefined);
      await this.#raise(status, "balance_unreadable", reading.error.message);
      return status;
    }

    const balance = reading.value;
    // A ledger rejection is the authoritative signal and outranks a cached
    // reading; a balance back above the threshold is the evidence that retires
    // it, since the rejection can only have been about the money.
    if (balance.availableStroops >= this.#thresholdStroops) {
      this.#reportedUnderfunded = false;
    }

    const kind = this.#classify(balance);
    const status: AnchorFundingStatus = { kind, balance };
    this.#lastStatus = status;

    this.#emitMetric(balance);
    await this.#raiseForBalance(balance, kind);

    return status;
  }

  /**
   * Polls on an interval until the returned function is called.
   *
   * The interval is the operator's, not the code's: an hourly anchoring job
   * needs checking at a similar cadence, while a deployment anchoring daily
   * learns about a drained account slower and doesn't need to poll often.
   * A check that throws must not kill the timer — the whole point is that
   * monitoring keeps reporting even while the thing it watches is broken.
   */
  start(intervalMs: number, onCheckError: (error: unknown) => void = () => undefined): () => void {
    const timer = setInterval(() => {
      this.check().catch(onCheckError);
    }, intervalMs);

    // Node keeps the process alive for a pending interval. A monitor started
    // from a CLI or a short-lived job would otherwise hang forever.
    timer.unref?.();

    return () => clearInterval(timer);
  }

  /**
   * `AnchorFundingGuard`: refuse to submit when the account cannot pay.
   *
   * Consults a fresh reading rather than the cached one. The cached answer can
   * be a polling interval out of date, and "we thought there was money" is not
   * a good basis for a decision that spends fees.
   */
  async beforeAnchor(): Promise<Result<void, AnchorError>> {
    const status = await this.check();

    if (status.kind === "funded") {
      return Result.ok(undefined);
    }

    if (status.kind === "unknown") {
      return Result.err(
        new AnchorError(
          `Not submitting an anchoring transaction: the funding state of ${this.#publicKey} could not be established (${status.error.message}).`,
        ),
      );
    }

    return Result.err(
      new AnchorError(
        `Not submitting an anchoring transaction: ${this.#publicKey} holds ${stroopsToXlm(status.balance.availableStroops).toFixed(7)} XLM, which cannot cover the ${String(this.#feeStroops)}-stroop fee.`,
      ),
    );
  }

  /**
   * `AnchorFundingGuard`: the ledger said no.
   *
   * Always alerts, ignoring deduplication — this is not the monitor's opinion
   * of a trend but a fact reported by the network, and one rejected
   * transaction means anchoring did not happen for whatever was being
   * committed.
   */
  async reportUnderfundedRejection(detail: string): Promise<void> {
    this.#reportedUnderfunded = true;
    await this.#raise(
      this.#lastStatus,
      "unfundable_anchor_attempt",
      `An anchoring transaction for ${this.#publicKey} was refused for insufficient funds: ${detail}`,
      { force: true },
    );
    // The rejection and the next poll's `unfundable` classification are the
    // same incident seen twice, so the deduplication key is moved to the
    // latter: it suppresses the follow-up page while still allowing
    // `recovered` to fire when the account is topped up.
    this.#lastAlertedKind = "unfundable";
  }

  #classify(balance: AnchorAccountBalance): "funded" | "below_threshold" | "unfundable" {
    if (this.#reportedUnderfunded || balance.availableStroops < this.#feeStroops) {
      return "unfundable";
    }

    return balance.availableStroops < this.#thresholdStroops ? "below_threshold" : "funded";
  }

  async #raiseForBalance(
    balance: AnchorAccountBalance,
    kind: "funded" | "below_threshold" | "unfundable",
  ): Promise<void> {
    if (kind === "funded") {
      if (this.#lastAlertedKind !== undefined) {
        await this.#raise(
          { kind, balance },
          "recovered",
          `${this.#publicKey} is funded again at ${stroopsToXlm(balance.availableStroops).toFixed(7)} XLM.`,
        );
      }
      return;
    }

    const message =
      kind === "unfundable"
        ? `${this.#publicKey} holds ${stroopsToXlm(balance.availableStroops).toFixed(7)} XLM, below the ${String(this.#feeStroops)} stroops an anchoring transaction costs.`
        : `${this.#publicKey} holds ${stroopsToXlm(balance.availableStroops).toFixed(7)} XLM, below the alert threshold of ${String(this.thresholdXlm)} XLM.`;

    await this.#raise({ kind, balance }, kind, message);
  }

  async #raise(
    status: AnchorFundingStatus | undefined,
    kind: AnchorFundingAlertKind,
    message: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!options.force && this.#lastAlertedKind === kind) return;

    const alert: AnchorFundingAlert = {
      kind,
      network:
        status?.kind === "unknown" || status === undefined ? "unknown" : status.balance.network,
      publicKey: this.#publicKey,
      availableXlm:
        status === undefined || status.kind === "unknown"
          ? undefined
          : stroopsToXlm(status.balance.availableStroops),
      thresholdXlm: this.thresholdXlm,
      message,
      observedAt: this.#now(),
    };

    this.#lastAlertedKind = kind;
    await this.#alerter.alert(alert);
  }

  #emitMetric(balance: AnchorAccountBalance | undefined): void {
    const fundable =
      balance !== undefined &&
      !this.#reportedUnderfunded &&
      balance.availableStroops >= this.#feeStroops;

    this.#metrics.emit({
      name: "verixa_stellar_anchor_balance_xlm",
      valueXlm: balance === undefined ? 0 : stroopsToXlm(balance.availableStroops),
      availableStroops: balance?.availableStroops ?? 0,
      thresholdStroops: this.#thresholdStroops,
      fundable,
      network: balance?.network ?? "unknown",
      publicKey: this.#publicKey,
      observedAt: this.#now(),
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The slice of a logger this file needs. Structural rather than pino's `Logger`
 * so the package does not acquire a logging dependency for one function, and
 * so any pino, Fastify, or console-shaped logger satisfies it.
 */
export interface StructuredErrorLogger {
  error(object: Record<string, unknown>): void;
}

/**
 * Alerter that writes each alert as one structured log record, with values as fields and no
 * assembled message, since some values come from outside the process (see
 * docs/security/audit-log-integrity.md). Logged at `error`, not `warn`, because a stopped control
 * is not a retryable hiccup.
 */
export function loggingFundingAlerter(logger: StructuredErrorLogger): AnchorFundingAlerter {
  return {
    alert: (alert) => {
      logger.error({ type: "anchor_funding_alert", ...alert });
    },
  };
}

/**
 * The common ledger reasons an anchoring transaction fails for want of funds.
 *
 * `op_underfunded` is the operation result code Stellar returns for a payment
 * that would overdraw the source account; the prose forms catch the Horizon
 * error strings that wrap it, plus the "account does not exist" case, which is
 * the same operational failure at a different stage of an account's life.
 */
const UNDERFUNDED_PATTERNS: readonly string[] = [
  "op_underfunded",
  "insufficient balance",
  "underfunded",
  "account not funded",
  "the source account does not have enough",
];

/** Whether a submission error means "this account cannot pay", as opposed to a network or timing fault. */
export function isUnderfundedLedgerError(error: unknown): boolean {
  const text = describeError(error).toLowerCase();
  if (text.includes("no such account")) return true;
  return UNDERFUNDED_PATTERNS.some((pattern) => text.includes(pattern));
}
