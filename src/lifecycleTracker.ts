import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";

export type CommitmentStage = "submitted" | "processed" | "confirmed" | "finalized" | "failed";

export type FailureType =
  | "expired_blockhash"
  | "fee_too_low"
  | "compute_exceeded"
  | "bundle_failure"
  | "leader_skipped"
  | "unknown";

export interface LifecycleEntry {
  id: string;
  signature: string | null;
  bundleId: string | null;
  tipAmount: number;
  tipAccount: string;
  submittedAt: number;
  submittedSlot: number;
  processedAt: number | null;
  processedSlot: number | null;
  confirmedAt: number | null;
  confirmedSlot: number | null;
  finalizedAt: number | null;
  finalizedSlot: number | null;
  failedAt: number | null;
  failedSlot: number | null;
  failureType: FailureType | null;
  failureReason: string | null;
  stage: CommitmentStage;
  retryCount: number;
  agentDecision: string | null;
  latencyDeltas: {
    submitted_to_processed: number | null;
    processed_to_confirmed: number | null;
    confirmed_to_finalized: number | null;
    total: number | null;
  };
}

export class LifecycleTracker {
  private entries: Map<string, LifecycleEntry> = new Map();
  private logDir: string;
  private sessionLogPath: string;

  constructor(logDir: string = "./logs") {
    this.logDir = logDir;
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
    this.sessionLogPath = path.join(logDir, `session-${sessionId}.json`);
    console.log(`[Tracker] Logging to ${this.sessionLogPath}`);
  }

  createEntry(params: {
    bundleId: string;
    tipAmount: number;
    tipAccount: string;
    submittedSlot: number;
  }): LifecycleEntry {
    const entry: LifecycleEntry = {
      id: uuidv4(),
      signature: null,
      bundleId: params.bundleId,
      tipAmount: params.tipAmount,
      tipAccount: params.tipAccount,
      submittedAt: Date.now(),
      submittedSlot: params.submittedSlot,
      processedAt: null,
      processedSlot: null,
      confirmedAt: null,
      confirmedSlot: null,
      finalizedAt: null,
      finalizedSlot: null,
      failedAt: null,
      failedSlot: null,
      failureType: null,
      failureReason: null,
      stage: "submitted",
      retryCount: 0,
      agentDecision: null,
      latencyDeltas: {
        submitted_to_processed: null,
        processed_to_confirmed: null,
        confirmed_to_finalized: null,
        total: null,
      },
    };
    this.entries.set(entry.id, entry);
    this.persist();
    console.log(`[Tracker] Entry created: ${entry.id} | Bundle: ${params.bundleId} | Slot: ${params.submittedSlot}`);
    return entry;
  }

  advance(id: string, stage: CommitmentStage, slot: number, signature?: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const now = Date.now();
    entry.stage = stage;
    if (signature) entry.signature = signature;

    switch (stage) {
      case "processed":
        entry.processedAt = now;
        entry.processedSlot = slot;
        entry.latencyDeltas.submitted_to_processed = now - entry.submittedAt;
        break;
      case "confirmed":
        entry.confirmedAt = now;
        entry.confirmedSlot = slot;
        entry.latencyDeltas.processed_to_confirmed = entry.processedAt ? now - entry.processedAt : null;
        break;
      case "finalized":
        entry.finalizedAt = now;
        entry.finalizedSlot = slot;
        entry.latencyDeltas.confirmed_to_finalized = entry.confirmedAt ? now - entry.confirmedAt : null;
        entry.latencyDeltas.total = now - entry.submittedAt;
        break;
    }
    this.persist();
    console.log(`[Tracker] ${id} → ${stage.toUpperCase()} | Slot: ${slot} | Elapsed: ${Date.now() - entry.submittedAt}ms`);
  }

  markFailed(id: string, slot: number, failureType: FailureType, failureReason: string, agentDecision?: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.stage = "failed";
    entry.failedAt = Date.now();
    entry.failedSlot = slot;
    entry.failureType = failureType;
    entry.failureReason = failureReason;
    if (agentDecision) entry.agentDecision = agentDecision;
    entry.latencyDeltas.total = Date.now() - entry.submittedAt;
    this.persist();
    console.log(`[Tracker] ${id} → FAILED | Type: ${failureType} | Reason: ${failureReason}`);
  }

  incrementRetry(id: string): void {
    const entry = this.entries.get(id);
    if (entry) { entry.retryCount++; this.persist(); }
  }

  setAgentDecision(id: string, decision: string): void {
    const entry = this.entries.get(id);
    if (entry) { entry.agentDecision = decision; this.persist(); }
  }

  getEntry(id: string): LifecycleEntry | undefined { return this.entries.get(id); }
  getAllEntries(): LifecycleEntry[] { return Array.from(this.entries.values()); }

  printSummary(): void {
    const entries = this.getAllEntries();
    const successful = entries.filter((e) => e.stage === "finalized").length;
    const failed = entries.filter((e) => e.stage === "failed").length;
    console.log("\n========= LIFECYCLE SUMMARY =========");
    console.log(`Total submissions: ${entries.length}`);
    console.log(`Finalized: ${successful} | Failed: ${failed}`);
    console.log("-------------------------------------");
    for (const e of entries) {
      const status = e.stage === "failed" ? `❌ FAILED (${e.failureType})` : e.stage === "finalized" ? `✅ FINALIZED` : `⏳ ${e.stage.toUpperCase()}`;
      console.log(`[${e.id.slice(0, 8)}] ${status} | Tip: ${e.tipAmount} lamports | Slot: ${e.submittedSlot} → ${e.finalizedSlot ?? e.failedSlot ?? "?"} | Total: ${e.latencyDeltas.total ?? "?"}ms | Retries: ${e.retryCount}`);
    }
    console.log("=====================================\n");
  }

  static classifyFailure(errorMessage: string): FailureType {
    const msg = errorMessage.toLowerCase();
    if (msg.includes("blockhash") || msg.includes("block hash")) return "expired_blockhash";
    if (msg.includes("insufficient") || msg.includes("fee") || msg.includes("lamports")) return "fee_too_low";
    if (msg.includes("compute") || msg.includes("exceeded")) return "compute_exceeded";
    if (msg.includes("bundle") || msg.includes("jito")) return "bundle_failure";
    if (msg.includes("leader") || msg.includes("skip")) return "leader_skipped";
    return "unknown";
  }

  private persist(): void {
    fs.writeFileSync(this.sessionLogPath, JSON.stringify(this.getAllEntries(), null, 2), "utf8");
  }
}
