import type {
  PrismaClient,
  VerificationStatus as DbVerificationStatus,
  VerificationType as DbVerificationType,
} from "@verixa/database";

import type {
  ClaimNextInReviewParams,
  ClaimNextOutcome,
  QueueCandidateOptions,
  VerificationRequestRepository,
} from "../../application/ports/verification-request-repository.js";
import type { ReviewerId } from "../../domain/entities/review-assignment.js";
import type {
  VerificationRequest,
  VerificationRequestId,
  VerificationSubjectId,
} from "../../domain/entities/verification-request.js";

import { withMappedErrors } from "./error-mapper.js";
import { toDbVerificationType, VerificationRequestMapper } from "./verification-request-mapper.js";

/**
 * The queue filter above, spelled in Prisma's where-input shape.
 *
 * Declared locally rather than reaching for Prisma's generated input type so
 * this file only depends on the pieces of it that are actually used; the
 * adapter still hands the object to `findMany`, which type-checks it against
 * the real input type at the call site.
 */
interface QueueCandidateWhere {
  status?: { in: DbVerificationStatus[] };
  type?: DbVerificationType;
  assignedReviewerId?: { not: null } | null;
  claimExpiresAt?: { gt: Date } | { lte: Date };
  OR?: QueueCandidateWhere[];
}

/**
 * Prisma-backed `VerificationRequestRepository`. Satisfies the same port — and
 * passes the same behavioral contract — as
 * `InMemoryVerificationRequestRepository`, which is what makes the two
 * substitutable rather than merely similar.
 *
 * Takes a `PrismaClient` rather than constructing one, so a caller can hand it
 * a transaction client instead.
 */
export class PrismaVerificationRequestRepository implements VerificationRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async save(request: VerificationRequest): Promise<void> {
    const row = VerificationRequestMapper.toRow(request);
    const { id, ...withoutId } = row;

    await withMappedErrors("VerificationRequest", () =>
      this.prisma.verificationRequest.upsert({
        where: { id },
        create: row,
        update: withoutId,
      }),
    );
  }

  async findById(id: VerificationRequestId): Promise<VerificationRequest | undefined> {
    const row = await this.prisma.verificationRequest.findUnique({ where: { id } });
    return row === null ? undefined : VerificationRequestMapper.toDomain(row);
  }

  async findBySubject(subjectUserId: VerificationSubjectId): Promise<VerificationRequest[]> {
    const rows = await this.prisma.verificationRequest.findMany({
      where: { subjectUserId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => VerificationRequestMapper.toDomain(row));
  }

  /**
   * Filtered, paginated queue read. A claim is a lease, so `assigned` requires a live claim, and
   * `unassigned` matches both never-claimed rows and rows whose claim expired (the reviewer column
   * is not cleared on expiry). This matches `VerificationRequest.isClaimableAt` and the in-memory
   * fake, as the contract suite checks.
   */
  async findQueueCandidates(options: QueueCandidateOptions = {}): Promise<VerificationRequest[]> {
    const now = options.now ?? new Date();
    const where: QueueCandidateWhere = {};

    if (options.statuses !== undefined) {
      // Copied into a mutable array: the port exposes the filter as a
      // `readonly` list, and Prisma's `in` is a mutable one.
      where.status = { in: [...options.statuses] };
    }
    if (options.verificationType !== undefined) {
      where.type = toDbVerificationType(options.verificationType);
    }
    if (options.assignment === "assigned") {
      where.assignedReviewerId = { not: null };
      where.claimExpiresAt = { gt: now };
    } else if (options.assignment === "unassigned") {
      where.OR = [{ assignedReviewerId: null }, { claimExpiresAt: { lte: now } }];
    }

    const rows = await this.prisma.verificationRequest.findMany({
      where,
      orderBy: { createdAt: "asc" },
      ...(options.limit !== undefined ? { take: options.limit } : {}),
      ...(options.offset !== undefined && options.offset > 0 ? { skip: options.offset } : {}),
    });
    return rows.map((row) => VerificationRequestMapper.toDomain(row));
  }

  async findActiveClaimByReviewer(
    reviewerId: ReviewerId,
    now: Date,
  ): Promise<VerificationRequest | undefined> {
    const row = await this.prisma.verificationRequest.findFirst({
      where: { assignedReviewerId: reviewerId, claimExpiresAt: { gt: now } },
      orderBy: { assignedAt: "asc" },
    });
    return row === null ? undefined : VerificationRequestMapper.toDomain(row);
  }

  /**
   * Race-safe claim using `FOR UPDATE SKIP LOCKED` in one transaction: the selected row is locked,
   * and a concurrent claim skips it and takes the next candidate instead of waiting. With the
   * status and expiry filters, two reviewers can never be handed the same request.
   */
  async claimNextInReview(params: ClaimNextInReviewParams): Promise<ClaimNextOutcome> {
    return this.prisma.$transaction(async (tx): Promise<ClaimNextOutcome> => {
      if (params.oneAtATime) {
        const existing = await tx.verificationRequest.findFirst({
          where: {
            assignedReviewerId: params.reviewerId,
            claimExpiresAt: { gt: params.now },
          },
          select: { id: true },
        });
        if (existing !== null) {
          return { kind: "already_claiming" };
        }
      }

      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "verification_requests"
        WHERE "status" = 'in_review'::"verification_status"
          AND ("assigned_reviewer_id" IS NULL OR "claim_expires_at" <= ${params.now})
        ORDER BY "created_at" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      const candidate = candidates[0];
      if (candidate === undefined) {
        return { kind: "none" };
      }

      const updated = await tx.verificationRequest.update({
        where: { id: candidate.id },
        data: {
          assignedReviewerId: params.reviewerId,
          assignedAt: params.now,
          claimExpiresAt: new Date(params.now.getTime() + params.claimTtlMs),
          updatedAt: params.now,
        },
      });

      return { kind: "claimed", request: VerificationRequestMapper.toDomain(updated) };
    });
  }
}
