/**
 * End-to-end demo: record audit events, chain them, anchor the head to the Stellar testnet and
 * verify it from the public ledger. Run with `pnpm --filter @verixa/audit demo`.
 *
 * Needs only network access; it funds a throwaway account from friendbot. The printed transaction
 * hash can be checked in any Stellar explorer.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { Result } from "@verixa/shared-kernel";
import { LocalTransactionSigner, StellarHashAnchor } from "@verixa/stellar-anchor";

import { AnchorAuditLog } from "../application/use-cases/anchor-audit-log.js";
import { RecordAuditEvent } from "../application/use-cases/record-audit-event.js";
import { verifyChain } from "../domain/entities/audit-log-entry.js";
import {
  InMemoryAnchorRecordRepository,
  InMemoryAuditLogRepository,
} from "../infrastructure/testing/in-memory-audit-repositories.js";

const FRIENDBOT_URL = "https://friendbot.stellar.org";

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function fundAccount(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!response.ok) {
    throw new Error(`friendbot funding failed with HTTP ${String(response.status)}`);
  }
  // Horizon needs a moment to make a newly funded account visible.
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

async function main(): Promise<void> {
  const auditLog = new InMemoryAuditLogRepository();
  const anchorRecords = new InMemoryAnchorRecordRepository();
  const record = new RecordAuditEvent(auditLog);

  log("1. Recording audit events");
  // The events a real deployment produces, in the order a real session would.
  await record.execute({
    action: "user.registered",
    subjectId: "11111111-1111-4111-8111-111111111111",
    metadata: { email: "alice@example.com" },
  });
  await record.execute({
    action: "user.login_failed",
    subjectId: "11111111-1111-4111-8111-111111111111",
    metadata: { reason: "bad_password" },
  });
  await record.execute({
    action: "user.login_succeeded",
    actorId: "11111111-1111-4111-8111-111111111111",
    subjectId: "11111111-1111-4111-8111-111111111111",
  });

  const entries = auditLog.all();
  for (const entry of entries) {
    log(`   #${String(entry.sequence)} ${entry.action}  ${entry.hash.slice(0, 16)}...`);
  }

  log("\n2. Verifying the hash chain locally");
  const localBreak = verifyChain(entries);
  if (localBreak !== undefined) {
    throw new Error(`chain broken at ${String(localBreak.sequence)}: ${localBreak.reason}`);
  }
  log("   chain intact");

  const head = entries.at(-1);
  if (head === undefined) throw new Error("no entries were recorded");
  log(`   head hash: ${head.hash}`);

  log("\n3. Funding a throwaway Stellar testnet account");
  const keypair = Keypair.random();
  await fundAccount(keypair.publicKey());
  log(`   ${keypair.publicKey()}`);

  log("\n4. Anchoring the chain head to Stellar");
  // A local, in-process signer: this demo has no KMS to talk to and a throwaway
  // testnet account to spend, which is exactly the case `LocalTransactionSigner`
  // exists for. A real deployment wires `KmsTransactionSigner` instead, so no
  // process ever holds the seed -- docs/security/stellar-key-management.md.
  const anchor = new StellarHashAnchor({
    signer: new LocalTransactionSigner(keypair.secret()),
    network: "testnet",
  });
  const anchored = await new AnchorAuditLog(auditLog, anchorRecords, anchor).execute();

  if (Result.isErr(anchored)) {
    throw new Error(`anchoring failed: ${anchored.error.message}`);
  }

  const { record: receipt, newlyCovered } = anchored.value;
  log(`   transaction: ${receipt.anchorRef}`);
  log(`   network:     ${receipt.network}`);
  log(
    `   covers:      ${String(newlyCovered)} entries, through sequence ${String(receipt.sequence)}`,
  );
  log(`   explorer:    https://stellar.expert/explorer/testnet/tx/${receipt.anchorRef}`);

  log("\n5. Verifying the commitment from the public ledger");
  // Deliberately performed the way an outside auditor would: read the memo
  // back off the ledger and compare. Nothing in this step consults the local
  // database, which is what makes the guarantee worth having.
  const verified = await anchor.verify(head.hash, receipt.anchorRef);
  if (Result.isErr(verified)) {
    throw new Error(`verification could not complete: ${verified.error.message}`);
  }
  log(`   ledger commits to the head hash: ${String(verified.value)}`);

  log("\n6. Confirming a tampered hash is rejected");
  // The negative case matters as much as the positive one: a verifier that
  // returns true for everything proves nothing.
  const tampered = `${head.hash.slice(0, 63)}${head.hash.endsWith("a") ? "b" : "a"}`;
  const rejected = await anchor.verify(tampered, receipt.anchorRef);
  if (Result.isErr(rejected)) {
    throw new Error(`verification could not complete: ${rejected.error.message}`);
  }
  log(`   altered hash verifies: ${String(rejected.value)}  (must be false)`);

  if (!Result.isOk(verified) || !verified.value || rejected.value) {
    throw new Error("verification did not behave as required");
  }

  log("\nDone. The audit log's integrity is now checkable by anyone, from the ledger alone.");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
