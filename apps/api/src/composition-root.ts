import { randomUUID } from "node:crypto";

import {
  AnchorAuditLog,
  BatchedAuditWriter,
  ExportAuditEvents,
  PrismaAnchorRecordRepository,
  PrismaAuditLogRepository,
  QueryAuditEvents,
  RecordAuditEvent,
  VerifyAuditChain,
  type AuditDelegate,
  type AuditEventReader,
  type AuditTransaction,
} from "@verixa/audit";
import { PrismaAuthorizationRepository, type AuthorizationRepository } from "@verixa/authorization";
import { loadConfig } from "@verixa/config";
import {
  Argon2PasswordHasher,
  AuthenticateWithPassword,
  DEFAULT_LOCKOUT_POLICY,
  ConfirmEmailVerification,
  ConfirmPasswordReset,
  NoSessionsRevoker,
  NullCredentialNotifier,
  PrismaCredentialsUnitOfWork,
  RegisterUserWithPassword,
  RequestEmailVerification,
  RequestPasswordReset,
} from "@verixa/credentials";
import { createPrismaClient, type PrismaClient } from "@verixa/database";
import {
  GetComplianceCase,
  InMemoryComplianceCaseRepository,
  ListComplianceCases,
  OpenComplianceCase,
  RecordComplianceApproval,
  TransitionComplianceCase,
  type PermissionCheck,
} from "@verixa/governance";
import {
  CreateOrganization,
  GetOrganization,
  GetOrganizationUsers,
  GetUser,
  GetUserOrganizations,
  GetUsersByOrganizationIds,
  InviteUserToOrganization,
  ListOrganizations,
  PrismaInvitationRepository,
  PrismaOrganizationMembershipRepository,
  PrismaOrganizationRepository,
  PrismaUnitOfWork,
  PrismaUserRepository,
  ReactivateUser,
  RegisterUser,
  SuspendUser,
  UpdateUserProfile,
} from "@verixa/identity";
import {
  InMemoryDomainEventPublisher,
  InMemoryMfaMethodRepository,
  InMemoryWebAuthnChallengeRepository,
  InMemoryWebAuthnCredentialRepository,
  RegisterWebAuthnCredential,
  VerifyWebAuthnAssertion,
  WebAuthnAssertionVerifier,
  WebAuthnAttestationVerifier,
} from "@verixa/mfa";
import type { NotificationComposition, NotificationWorker } from "@verixa/notifications";
import {
  InMemoryRevocationList,
  InMemorySessionAuditLogger,
  IssueSession,
  JwtTokenSigner,
  Logout,
  PrismaSessionRepository,
  RefreshAccessToken,
  SessionExpiryPolicy,
  SigningKeyProvider,
} from "@verixa/sessions";
import {
  BruteForcePolicy,
  InMemoryBruteForceAttemptStore,
  InMemoryEventPublisher,
  NoopRateLimiter,
  type DomainEventPublisher,
  type RateLimiter,
} from "@verixa/shared-kernel";
import {
  LocalTransactionSigner,
  StellarHashAnchor,
  type StellarNetwork,
  type TransactionSigner,
} from "@verixa/stellar-anchor";

import {
  createObservabilityComponents,
  type ObservabilityContainer,
} from "./composition/observability.js";
import { createCredentialRateLimiter } from "./composition/rate-limiting.js";
import { registerAuditSubscribers } from "./composition/register-audit-subscribers.js";
import { registerNotificationSubscribers } from "./composition/register-notification-subscribers.js";
import type { PolicyRouteDependencies } from "./routes/policy.js";

/**
 * The composition root: the only place that knows which concrete implementations exist. Nothing
 * outside this file may import a `Prisma*` class, which keeps the application layer testable
 * without a database. Wiring is explicit rather than a DI container, so a missing dependency is a
 * compile error.
 */

/**
 * Creates the Prisma client with pool settings from validated config (`DATABASE_POOL_SIZE`,
 * `DATABASE_POOL_TIMEOUT_SECONDS`). Explicit `connection_limit` and `pool_timeout` parameters in
 * `DATABASE_URL` still win (see `pgPoolConfig` in @verixa/database).
 */
function createConfiguredPrismaClient(): PrismaClient {
  const config = loadConfig();
  return createPrismaClient(config.DATABASE_URL, {
    poolSize: config.DATABASE_POOL_SIZE,
    poolTimeoutSeconds: config.DATABASE_POOL_TIMEOUT_SECONDS,
  });
}

/**
 * Transaction runner for the audit log's compare-and-set append. A runner rather than an open
 * transaction, so the repository decides where the boundary goes, and the audit package never
 * references Prisma.
 */
function auditTransaction(prisma: PrismaClient): AuditTransaction {
  return <T>(work: (entries: AuditDelegate) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx) => work(tx.auditLogEntry));
}

/**
 * Reads a positive integer setting, falling back when absent or malformed.
 *
 * Not validated by `@verixa/config` because these are tuning knobs for one
 * adapter rather than part of the app's configuration contract, and a typo in
 * `AUDIT_FLUSH_INTERVAL_MS` should degrade to the documented default rather
 * than prevent the API from starting.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolves the anchoring signer from `STELLAR_SIGNING_BACKEND`.
 *
 * - `local`: the key is in this process's environment. Refused on the public network unless
 *   `STELLAR_ALLOW_LOCAL_SIGNING=1`.
 * - `kms`: the key never enters this process; the deployment supplies the signer through
 *   `ContainerOverrides.signer`. Missing it is a startup error rather than silently disabling
 *   anchoring.
 *
 * When unset: `local` if `STELLAR_ANCHOR_SECRET_KEY` is present, otherwise no signer.
 */
function resolveSigner(
  overrides: ContainerOverrides,
  network: StellarNetwork,
): TransactionSigner | undefined {
  const backend = process.env["STELLAR_SIGNING_BACKEND"];

  if (backend === "kms") {
    if (overrides.signer === undefined) {
      throw new Error(
        'STELLAR_SIGNING_BACKEND is "kms" but no signer was supplied. Build a KmsTransactionSigner with your key service client at composition time and pass it as buildContainer(undefined, { signer }). See docs/security/stellar-key-management.md.',
      );
    }
    return overrides.signer;
  }

  if (overrides.signer !== undefined) {
    return overrides.signer;
  }

  const secretKey = process.env["STELLAR_ANCHOR_SECRET_KEY"];
  if (secretKey === undefined || secretKey === "") {
    return undefined;
  }

  if (network === "public" && process.env["STELLAR_ALLOW_LOCAL_SIGNING"] !== "1") {
    throw new Error(
      "Refusing to anchor on the public network with a key read from the environment. Use STELLAR_SIGNING_BACKEND=kms, or set STELLAR_ALLOW_LOCAL_SIGNING=1 only if you accept the risk described in docs/security/stellar-key-management.md.",
    );
  }

  return new LocalTransactionSigner(secretKey);
}

/** Every use case the application exposes, fully wired. */
export interface IdentityUseCases {
  readonly registerUser: RegisterUser;
  readonly updateUserProfile: UpdateUserProfile;
  readonly suspendUser: SuspendUser;
  readonly reactivateUser: ReactivateUser;
  readonly createOrganization: CreateOrganization;
  readonly inviteUserToOrganization: InviteUserToOrganization;
  readonly getUser: GetUser;
  readonly getOrganization: GetOrganization;
  readonly getOrganizationUsers: GetOrganizationUsers;
  readonly getUserOrganizations: GetUserOrganizations;
  readonly getUsersByOrganizationIds: GetUsersByOrganizationIds;
  readonly listOrganizations: ListOrganizations;
}

/** Use cases spanning identity and credentials. */
export interface CredentialUseCases {
  readonly registerUserWithPassword: RegisterUserWithPassword;
  readonly authenticateWithPassword: AuthenticateWithPassword;
  readonly requestEmailVerification: RequestEmailVerification;
  readonly confirmEmailVerification: ConfirmEmailVerification;
  readonly requestPasswordReset: RequestPasswordReset;
  readonly confirmPasswordReset: ConfirmPasswordReset;
}

/** Audit recording, query, integrity verification and its external anchoring. */
export interface AuditUseCases {
  readonly recordEvent: RecordAuditEvent;
  /**
   * Re-derives the hash chain and reports the first divergence.
   *
   * Wired here rather than left to the CLI alone, because the check is only a
   * control if something can run it on a schedule; a tool a human has to
   * remember to invoke is a tool that gets invoked after the incident.
   */
  readonly verifyChain: VerifyAuditChain;
  /**
   * Present only when an anchoring ledger is configured.
   *
   * Absent rather than a no-op, so a deployment that has not set up anchoring
   * cannot believe it has. A silent stub here would be the worst outcome
   * available: an operator who thinks their audit log is externally verifiable
   * when nothing has ever been committed anywhere.
   */
  readonly anchor: AnchorAuditLog | undefined;
  readonly queryEvents?: QueryAuditEvents | undefined;
  readonly exportEvents?: ExportAuditEvents | undefined;
}

/** Multi-factor authentication use cases. */
export interface MfaUseCases {
  readonly registerWebAuthnCredential: RegisterWebAuthnCredential;
  readonly verifyWebAuthnAssertion: VerifyWebAuthnAssertion;
}

/** Session authentication use cases. */
export interface SessionUseCases {
  readonly issueSession: IssueSession;
  readonly refreshAccessToken: RefreshAccessToken;
  readonly logout: Logout;
}

export interface GovernanceUseCases {
  readonly openCase: OpenComplianceCase;
  readonly getCase: GetComplianceCase;
  readonly listCases: ListComplianceCases;
  readonly transitionCase: TransitionComplianceCase;
  readonly recordApproval: RecordComplianceApproval;
  readonly permissions: PermissionCheck;
}

export interface Container {
  readonly prisma: PrismaClient;
  readonly eventPublisher: DomainEventPublisher;
  readonly identity: IdentityUseCases;
  readonly credentials: CredentialUseCases;
  readonly audit: AuditUseCases;
  readonly authorization: AuthorizationRepository;
  /** Supplied when the governance persistence/use-case layer is enabled. */
  readonly governancePolicies?: PolicyRouteDependencies;
  readonly notifications: {
    readonly worker: NotificationWorker | undefined;
  };
  readonly sessions?: SessionUseCases;
  readonly rateLimiter?: RateLimiter;
  /** Compliance case management. Absent in partial test containers. */
  readonly governance?: GovernanceUseCases;
  /**
   * Drains any queued audit writes, then releases the database connection.
   * Call on shutdown.
   */
  readonly mfa: MfaUseCases;
  readonly observability?: ObservabilityContainer;
  /** Releases the database connection. Call on shutdown. */
  readonly dispose: () => Promise<void>;
}

/**
 * Pieces a deployment must supply because they cannot be derived from
 * environment variables alone.
 */
export interface ContainerOverrides {
  /**
   * A signer built by the deployment, for `STELLAR_SIGNING_BACKEND=kms`.
   *
   * It lives here rather than behind another environment variable because the
   * point of the key service is that *this process never holds the key* — the
   * SDK client that talks to it is configured by its own credential chain, and
   * reconstructing that from strings here would put the credential management
   * problem back where it started.
   */
  readonly signer?: TransactionSigner | undefined;
  readonly auditEventReader?: AuditEventReader | undefined;
  readonly queryAuditEvents?: QueryAuditEvents | undefined;
  readonly exportAuditEvents?: ExportAuditEvents | undefined;
  readonly rateLimiter?: RateLimiter | undefined;
  /** Notification subscribers and worker supplied by the notification phase. */
  readonly notificationComposition?: NotificationComposition | undefined;
}

/**
 * Wires compliance case management.
 *
 * Cases live in process memory for now (see `InMemoryComplianceCaseRepository`);
 * swapping in a database adapter changes only the repository constructed here.
 * Approver eligibility is answered by the RBAC store: signing off as role `R`
 * requires the `compliance-cases:approve:R` permission in the organization.
 */
export function buildGovernance(authorization: AuthorizationRepository): GovernanceUseCases {
  const repository = new InMemoryComplianceCaseRepository();
  const publisher = new InMemoryEventPublisher();
  return {
    openCase: new OpenComplianceCase(repository, publisher),
    getCase: new GetComplianceCase(repository),
    listCases: new ListComplianceCases(repository),
    transitionCase: new TransitionComplianceCase(repository, publisher),
    recordApproval: new RecordComplianceApproval(repository, publisher, {
      canApproveAs: (userId, organizationId, role) =>
        authorization.hasPermission(userId, organizationId, `compliance-cases:approve:${role}`),
    }),
    permissions: {
      hasPermission: (userId, organizationId, permission) =>
        authorization.hasPermission(userId, organizationId, permission),
    },
  };
}

/**
 * Builds the object graph.
 *
 * Takes an optional `PrismaClient` so tests can inject one pointed at a
 * throwaway database. Production passes nothing and gets a client configured
 * from `DATABASE_URL`.
 */
export function buildContainer(
  prismaClient?: PrismaClient,
  overrides: ContainerOverrides = {},
): Container {
  const prisma = prismaClient ?? createConfiguredPrismaClient();

  const users = new PrismaUserRepository(prisma);
  const organizations = new PrismaOrganizationRepository(prisma);
  const memberships = new PrismaOrganizationMembershipRepository(prisma);
  const authorization = new PrismaAuthorizationRepository(prisma);
  const invitations = new PrismaInvitationRepository(prisma);
  const unitOfWork = new PrismaUnitOfWork(prisma);

  // One hasher for the process, not one per request. Its cost parameters are
  // fixed configuration; constructing it per call would allocate for nothing.
  const passwordHasher = new Argon2PasswordHasher();
  const credentialsUnitOfWork = new PrismaCredentialsUnitOfWork(prisma);

  // Default adapters until the real ones are wired: `NullCredentialNotifier` delivers nothing and
  // never logs tokens, `NoSessionsRevoker` revokes nothing, and `NoopRateLimiter` allows every
  // request. The call sites already exist, so wiring the real adapters needs no use-case changes.
  const credentialNotifier = new NullCredentialNotifier();
  const sessionRevoker = new NoSessionsRevoker();
  const rateLimiter: RateLimiter =
    overrides.rateLimiter ??
    (process.env["NODE_ENV"] === "test" ? new NoopRateLimiter() : createCredentialRateLimiter());
  // Counts failures the per-credential lockout cannot see (unknown addresses,
  // password spraying). In-memory and per process until a durable store is wired.
  const bruteForceAttempts = new BruteForcePolicy(new InMemoryBruteForceAttemptStore());

  // Audit recording. Failures are logged and never propagated -- see
  // RecordAuditEvent on why a failed audit write must not fail the operation
  // it was recording.
  const auditLog = new PrismaAuditLogRepository(prisma.auditLogEntry, auditTransaction(prisma));
  const anchorRecords = new PrismaAnchorRecordRepository(prisma.anchorRecord, () => randomUUID());

  // Batched writes are opt-in. The default keeps the per-event
  // writer, whose behaviour — an entry is durable before the request returns —
  // is the one an operator who has not read the throughput document will
  // assume. Turning batching on trades that for throughput, so it is a
  // deployment decision and stated as an environment variable, not a code
  // change at every call site.
  const batched = process.env["AUDIT_BATCHED_WRITES"] === "1";
  const batchedWriter = batched
    ? new BatchedAuditWriter(auditLog, {
        maxBatchSize: positiveIntFromEnv("AUDIT_MAX_BATCH_SIZE", 100),
        flushIntervalMs: positiveIntFromEnv("AUDIT_FLUSH_INTERVAL_MS", 250),
        maxQueueSize: positiveIntFromEnv("AUDIT_MAX_QUEUE_SIZE", 10_000),
        onOverflow: (report) => {
          // The overflow *metric*. Refusing to write is correct behaviour, but
          // it is only defensible if somebody can see it happening.
          process.stderr.write(
            `audit queue full: refused "${report.dropped.action}" (${String(report.queueLength)}/${String(report.queueLimit)} pending, ${String(report.overflowedTotal)} refused total)\n`,
          );
        },
        onBatchFailure: (report) => {
          process.stderr.write(
            `audit batch lost: ${String(report.commands.length)} entries dropped after ${String(report.attempts)} attempts\n`,
          );
        },
      }).start()
    : undefined;

  const recordAuditEvent = new RecordAuditEvent(auditLog, (error: unknown) => {
    // Written to stderr rather than swallowed entirely: a gap in the audit
    // log is itself a security-relevant event, and the sequence gap it
    // leaves is deliberately visible to `verifyChain`.
    process.stderr.write(
      `audit write failed: ${error instanceof Error ? error.message : String(error)}
`,
    );
  });

  // Domain event publisher, with every audit subscriber already on it.
  //
  // Registration is part of building the container rather than something a
  // caller does afterwards, because the ordering is a correctness property, not
  // a setup step: an event published with no subscriber attached is dropped
  // permanently, and the first request a process serves is also the first
  // event it publishes. See `composition/register-audit-subscribers.ts`.
  const eventPublisher = new InMemoryEventPublisher();
  registerAuditSubscribers(eventPublisher, recordAuditEvent);
  const notificationComposition = overrides.notificationComposition;
  if (notificationComposition !== undefined) {
    registerNotificationSubscribers(eventPublisher, notificationComposition.subscribers);
    notificationComposition.worker.start();
  }

  // Anchoring is wired only when a signing key is configured. See AuditUseCases
  // on why this is `undefined` rather than a no-op.
  const stellarNetwork: StellarNetwork =
    process.env["STELLAR_NETWORK"] === "public" ? "public" : "testnet";
  const signer = resolveSigner(overrides, stellarNetwork);
  const hashAnchor =
    signer === undefined ? undefined : new StellarHashAnchor({ signer, network: stellarNetwork });

  // Multi-factor authentication (MFA) use cases and WebAuthn verifier adapters.
  const webauthnRpId = process.env["WEBAUTHN_RP_ID"] ?? "localhost";
  const webauthnOrigin = process.env["WEBAUTHN_ORIGIN"] ?? "http://localhost:3000";

  const mfaMethodRepo = new InMemoryMfaMethodRepository();
  const webAuthnCredentialRepo = new InMemoryWebAuthnCredentialRepository();
  const webAuthnChallengeRepo = new InMemoryWebAuthnChallengeRepository();
  const mfaEventPublisher = new InMemoryDomainEventPublisher();
  const attestationVerifier = new WebAuthnAttestationVerifier();
  const assertionVerifier = new WebAuthnAssertionVerifier();

  const registerWebAuthnCredential = new RegisterWebAuthnCredential(
    mfaMethodRepo,
    webAuthnCredentialRepo,
    webAuthnChallengeRepo,
    attestationVerifier,
    {
      expectedOrigin: webauthnOrigin,
      expectedRpId: webauthnRpId,
    },
  );

  const verifyWebAuthnAssertion = new VerifyWebAuthnAssertion(
    mfaMethodRepo,
    webAuthnCredentialRepo,
    webAuthnChallengeRepo,
    assertionVerifier,
    mfaEventPublisher,
    {
      expectedOrigin: webauthnOrigin,
      expectedRpId: webauthnRpId,
    },
  );

  return {
    prisma,
    eventPublisher,
    rateLimiter,
    identity: {
      registerUser: new RegisterUser(users),
      updateUserProfile: new UpdateUserProfile(users),
      suspendUser: new SuspendUser(users),
      reactivateUser: new ReactivateUser(users),
      // Takes the unit of work rather than the two repositories: it writes an
      // organization and a membership, and those must commit together.
      createOrganization: new CreateOrganization(unitOfWork),
      inviteUserToOrganization: new InviteUserToOrganization(invitations),
      getUser: new GetUser(users),
      getOrganization: new GetOrganization(organizations),
      getOrganizationUsers: new GetOrganizationUsers(memberships, users),
      getUserOrganizations: new GetUserOrganizations(memberships, organizations),
      getUsersByOrganizationIds: new GetUsersByOrganizationIds(memberships, users),
      listOrganizations: new ListOrganizations(organizations),
    },
    credentials: {
      registerUserWithPassword: new RegisterUserWithPassword(
        credentialsUnitOfWork,
        passwordHasher,
        rateLimiter,
      ),
      // Shares the hasher instance with registration deliberately. Beyond
      // avoiding a second allocation, the timing decoy that hides whether an
      // account exists is cached per hasher, so a second instance would build
      // its own on the first failed login.
      authenticateWithPassword: new AuthenticateWithPassword(
        credentialsUnitOfWork,
        passwordHasher,
        rateLimiter,
        DEFAULT_LOCKOUT_POLICY,
        undefined, // no MFA checker wired yet
        bruteForceAttempts,
      ),
      requestEmailVerification: new RequestEmailVerification(
        credentialsUnitOfWork,
        credentialNotifier,
      ),
      confirmEmailVerification: new ConfirmEmailVerification(credentialsUnitOfWork),
      requestPasswordReset: new RequestPasswordReset(
        credentialsUnitOfWork,
        credentialNotifier,
        rateLimiter,
      ),
      confirmPasswordReset: new ConfirmPasswordReset(
        credentialsUnitOfWork,
        passwordHasher,
        sessionRevoker,
        rateLimiter,
        undefined, // password policy: the default
        undefined, // password history policy: the default
        bruteForceAttempts,
      ),
    },
    audit: {
      recordEvent: recordAuditEvent,
      // Verification is given the same ledger the anchor use case uses, so a
      // deployment that anchors gets the independent ledger check for free and
      // one that does not still gets the local re-derivation. `undefined` is
      // honest here in the other direction: `VerifyAuditChain` reports
      // `anchorsSkipped` rather than quietly returning an empty receipt list.
      verifyChain: new VerifyAuditChain(auditLog, anchorRecords, hashAnchor),
      anchor:
        hashAnchor === undefined
          ? undefined
          : new AnchorAuditLog(auditLog, anchorRecords, hashAnchor),
      queryEvents:
        overrides.queryAuditEvents ??
        (overrides.auditEventReader
          ? new QueryAuditEvents(overrides.auditEventReader, recordAuditEvent)
          : undefined),
      exportEvents:
        overrides.exportAuditEvents ??
        (overrides.auditEventReader
          ? new ExportAuditEvents(overrides.auditEventReader, recordAuditEvent)
          : undefined),
    },
    authorization,
    governance: buildGovernance(authorization),
    notifications: {
      worker: notificationComposition?.worker,
    },
    sessions: {
      issueSession: new IssueSession(
        new PrismaSessionRepository(prisma),
        new JwtTokenSigner(
          new SigningKeyProvider({
            secret:
              process.env["SESSION_ACCESS_TOKEN_SECRET"] ??
              "verixa-development-secret-key-at-least-32-chars-long",
          }),
        ),
        SessionExpiryPolicy.default(),
        new InMemoryRevocationList(),
        new InMemorySessionAuditLogger(),
      ),
      refreshAccessToken: new RefreshAccessToken(
        new PrismaSessionRepository(prisma),
        new JwtTokenSigner(
          new SigningKeyProvider({
            secret:
              process.env["SESSION_ACCESS_TOKEN_SECRET"] ??
              "verixa-development-secret-key-at-least-32-chars-long",
          }),
        ),
        new InMemoryRevocationList(),
        SessionExpiryPolicy.default(),
        rateLimiter,
      ),
      logout: new Logout(new PrismaSessionRepository(prisma), new InMemoryRevocationList()),
    },
    mfa: {
      registerWebAuthnCredential,
      verifyWebAuthnAssertion,
    },
    observability: createObservabilityComponents({
      environment: process.env["NODE_ENV"],
      prisma,
    }),
    dispose: async () => {
      // Drained *before* disconnecting, and only because the batched writer
      // may hold entries that are not in the database yet. Skipping this is
      // the one way the queue's bounded delay becomes permanent data loss.
      await batchedWriter?.stop();
      await notificationComposition?.worker.stop();
      await prisma.$disconnect();
    },
  };
}
