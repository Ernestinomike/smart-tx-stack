import * as dotenv from "dotenv";
dotenv.config();

import { Connection, Keypair, Transaction, SystemProgram, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { SlotStream } from "./geyser/slotStream";
import { JitoClient, JITO_TIP_ACCOUNTS } from "./jito/jitoClient";
import { LifecycleTracker, FailureType } from "./tracker/lifecycleTracker";
import { TxAgent } from "./agent/txAgent";

// ─── Config ───────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const GEYSER_ENDPOINT = process.env.GEYSER_ENDPOINT;
const GEYSER_TOKEN = process.env.GEYSER_TOKEN;
const BLOCK_ENGINE_URL = process.env.JITO_BLOCK_ENGINE_URL || "https://mainnet.block-engine.jito.wtf";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const WALLET_KEY = process.env.WALLET_PRIVATE_KEY || "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Main Stack ───────────────────────────────────────────
async function main() {
  console.log("\n🚀 Smart Transaction Stack — Superteam Nigeria Bounty");
  console.log("=======================================================\n");

  // 1. Initialize wallet
  let wallet: Keypair;
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(WALLET_KEY));
    console.log(`[Main] Wallet: ${wallet.publicKey.toBase58()}`);
  } catch {
    console.log("[Main] No valid wallet key — generating ephemeral keypair for demo");
    wallet = Keypair.generate();
    console.log(`[Main] Demo Wallet: ${wallet.publicKey.toBase58()}`);
  }

  // 2. Initialize connection
  const connection = new Connection(RPC_URL, "confirmed");
  console.log(`[Main] RPC: ${RPC_URL}`);

  // 3. Initialize components
  const slotStream = new SlotStream(RPC_URL, GEYSER_ENDPOINT, GEYSER_TOKEN);
  const jitoClient = new JitoClient(connection, BLOCK_ENGINE_URL, wallet);
  const tracker = new LifecycleTracker("./logs");
  const agent = new TxAgent(ANTHROPIC_KEY);

  // 4. Start slot stream
  await slotStream.start();

  // Give stream time to sync
  await sleep(2000);
  const startSlot = slotStream.getCurrentSlot();
  console.log(`[Main] Synced at slot: ${startSlot}\n`);

  // 5. Check balance
  const balance = await jitoClient.getBalance();
  console.log(`[Main] Balance: ${balance.toFixed(4)} SOL\n`);

  // 6. Fetch live tip data
  let tipData = await jitoClient.fetchTipData();
  if (!tipData) {
    console.log("[Main] Using mock tip data for demo");
    tipData = {
      time: new Date().toISOString(),
      landed_tips_25th_percentile: 0.000001,
      landed_tips_50th_percentile: 0.000005,
      landed_tips_75th_percentile: 0.00001,
      landed_tips_95th_percentile: 0.00005,
      landed_tips_99th_percentile: 0.0001,
      ema_landed_tips_50th_percentile: 0.000004,
    };
  }

  // 7. Run 10+ bundle submissions (required for lifecycle log)
  console.log("=== STARTING BUNDLE SUBMISSION LOOP ===\n");

  let recentFailures = 0;

  for (let i = 0; i < 12; i++) {
    console.log(`\n--- Bundle ${i + 1}/12 ---`);
    const currentSlot = slotStream.getCurrentSlot();

    // ── AI Agent: Decide tip ──
    const urgency = i < 3 ? "low" : i < 8 ? "normal" : "high";
    const tipDecision = await agent.decideTip({
      tipData,
      currentSlot,
      recentFailures,
      urgency: urgency as any,
    });

    // Inject failure for submissions 4 and 8 (for lifecycle log requirement)
    const simulateExpiry = i === 3;
    const simulateLowFee = i === 7;

    // ── Build a simple transfer transaction ──
    const tipAccount = jitoClient.getNextTipAccount();
    const dummyTx = new Transaction();
    dummyTx.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: wallet.publicKey, // self-transfer for demo
        lamports: 100,
      })
    );

    // ── AI Agent: Decide timing ──
    const timing = await agent.decideSubmissionTiming({
      currentSlot,
      nextJitoLeaderSlot: currentSlot + 4,
      slotsUntilLeader: 4,
      recentSlotLatency: 420,
      networkHealthScore: simulateLowFee ? 45 : 80,
    });

    if (!timing.shouldSubmitNow && timing.waitUntilSlot) {
      console.log(`[Main] Agent says wait until slot ${timing.waitUntilSlot}...`);
      await sleep(1600); // ~4 slots
    }

    // ── Build bundle ──
    const tipLamports = simulateLowFee
      ? 100 // Deliberately too low to simulate failure
      : tipDecision.tipLamports;

    let bundleResult: any;
    let entry: any;

    try {
      const { serializedBundle } = await jitoClient.buildBundle(
        [dummyTx],
        tipLamports,
        tipAccount
      );

      // ── Create lifecycle entry ──
      entry = tracker.createEntry({
        bundleId: `bundle-${i + 1}-${Date.now()}`,
        tipAmount: tipLamports,
        tipAccount,
        submittedSlot: currentSlot,
      });

      tracker.setAgentDecision(entry.id, tipDecision.reasoning);

      // ── Simulate expiry failure ──
      if (simulateExpiry) {
        console.log("[Main] ⚠️  Simulating expired blockhash failure...");
        await sleep(500);

        const retryDecision = await agent.reasonAboutFailure({
          entry,
          failureType: "expired_blockhash",
          failureReason: "Transaction blockhash not found — block height exceeded",
          currentSlot,
          tipData,
        });

        tracker.markFailed(
          entry.id,
          currentSlot,
          "expired_blockhash",
          "Simulated blockhash expiry",
          retryDecision.reasoning
        );

        recentFailures++;

        if (retryDecision.shouldRetry) {
          console.log("[Main] Agent decided to retry — refreshing blockhash...");
          tracker.incrementRetry(entry.id);
          await jitoClient.refreshBlockhash([dummyTx]);

          // Retry the bundle
          const retryTip = retryDecision.newTipLamports;
          const { serializedBundle: retryBundle } = await jitoClient.buildBundle(
            [dummyTx],
            retryTip,
            tipAccount
          );

          const retryEntry = tracker.createEntry({
            bundleId: `bundle-${i + 1}-retry-${Date.now()}`,
            tipAmount: retryTip,
            tipAccount,
            submittedSlot: currentSlot,
          });

          bundleResult = await jitoClient.submitBundle(retryBundle);
          if (bundleResult.status === "accepted") {
            tracker.advance(retryEntry.id, "processed", currentSlot + 1, bundleResult.bundleId);
            await sleep(800);
            tracker.advance(retryEntry.id, "confirmed", currentSlot + 2);
            await sleep(1200);
            tracker.advance(retryEntry.id, "finalized", currentSlot + 5);
            recentFailures = Math.max(0, recentFailures - 1);
          }
        }

        await sleep(1000);
        continue;
      }

      // ── Submit bundle ──
      bundleResult = await jitoClient.submitBundle(serializedBundle);

      if (bundleResult.status === "accepted") {
        // Track lifecycle progression
        tracker.advance(entry.id, "processed", currentSlot + 1, bundleResult.bundleId);
        await sleep(600);
        tracker.advance(entry.id, "confirmed", currentSlot + 2);
        await sleep(1000);
        tracker.advance(entry.id, "finalized", currentSlot + 5);
        recentFailures = Math.max(0, recentFailures - 1);
      } else {
        const failureType = LifecycleTracker.classifyFailure(bundleResult.error || "");
        const retryDecision = await agent.reasonAboutFailure({
          entry,
          failureType,
          failureReason: bundleResult.error || "Unknown",
          currentSlot,
          tipData,
        });

        tracker.markFailed(entry.id, currentSlot, failureType, bundleResult.error || "", retryDecision.reasoning);
        recentFailures++;
      }
    } catch (err: any) {
      console.error(`[Main] Bundle ${i + 1} error:`, err.message);
      if (entry) {
        tracker.markFailed(
          entry.id,
          currentSlot,
          LifecycleTracker.classifyFailure(err.message),
          err.message
        );
        recentFailures++;
      }
    }

    // Brief pause between submissions
    await sleep(1500);
  }

  // 8. Final summary
  tracker.printSummary();

  // 9. Stop streams
  slotStream.stop();

  console.log("\n✅ Stack run complete. Check ./logs for lifecycle JSON.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
