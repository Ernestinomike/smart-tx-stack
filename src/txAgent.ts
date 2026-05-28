import axios from "axios";
import { TipData } from "../jito/jitoClient";
import { LifecycleEntry, FailureType } from "../tracker/lifecycleTracker";

export interface TipDecision {
  tipLamports: number;
  reasoning: string;
  confidence: "low" | "medium" | "high";
  strategy: "aggressive" | "balanced" | "conservative";
}

export interface RetryDecision {
  shouldRetry: boolean;
  newTipLamports: number;
  refreshBlockhash: boolean;
  waitSlots: number;
  reasoning: string;
}

export interface TimingDecision {
  shouldSubmitNow: boolean;
  waitUntilSlot: number | null;
  reasoning: string;
}

/**
 * TxAgent - AI-powered decision maker for the transaction stack
 * Uses Claude to reason about tip amounts, failure recovery, and submission timing
 * This agent makes REAL decisions — not hardcoded logic
 */
export class TxAgent {
  private apiKey: string;
  private model: string = "claude-sonnet-4-20250514";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * TIP INTELLIGENCE - Agent decides how much to tip each bundle
   * Analyzes live tip floor data + network conditions
   */
  async decideTip(params: {
    tipData: TipData;
    currentSlot: number;
    recentFailures: number;
    urgency: "low" | "normal" | "high";
  }): Promise<TipDecision> {
    const { tipData, currentSlot, recentFailures, urgency } = params;

    const prompt = `You are the tip intelligence module of a Solana transaction stack.

Your job: decide the optimal Jito bundle tip in lamports for the next submission.

## Current Network Conditions
- Current slot: ${currentSlot}
- Recent failures: ${recentFailures} in last 10 submissions
- Urgency level: ${urgency}

## Live Tip Floor Data (in SOL)
- 25th percentile: ${tipData.landed_tips_25th_percentile}
- 50th percentile: ${tipData.landed_tips_50th_percentile}  
- 75th percentile: ${tipData.landed_tips_75th_percentile}
- 95th percentile: ${tipData.landed_tips_95th_percentile}
- EMA 50th percentile: ${tipData.ema_landed_tips_50th_percentile}

## Your Decision Framework
- Conservative: Use 25-50th percentile (save cost, acceptable miss rate)
- Balanced: Use 50-75th percentile (good landing probability, moderate cost)
- Aggressive: Use 75-95th percentile (high landing probability, higher cost)

Consider:
1. If recent failures > 3, increase tip strategy
2. High urgency = favor landing probability over cost
3. EMA vs current spread indicates tip volatility

Respond in this EXACT JSON format only:
{
  "tipLamports": <integer>,
  "reasoning": "<2-3 sentence explanation of your decision>",
  "confidence": "low|medium|high",
  "strategy": "aggressive|balanced|conservative"
}`;

    try {
      const response = await this.callClaude(prompt);
      const parsed = JSON.parse(response);
      console.log(`[Agent] Tip decision: ${parsed.tipLamports} lamports | Strategy: ${parsed.strategy}`);
      console.log(`[Agent] Reasoning: ${parsed.reasoning}`);
      return parsed as TipDecision;
    } catch (err) {
      // Fallback: use 75th percentile converted to lamports
      const fallback = Math.ceil(tipData.landed_tips_75th_percentile * 1e9);
      console.log(`[Agent] AI call failed — using fallback tip: ${fallback} lamports`);
      return {
        tipLamports: fallback,
        reasoning: "Fallback to 75th percentile due to AI unavailability",
        confidence: "low",
        strategy: "balanced",
      };
    }
  }

  /**
   * FAILURE REASONING - Agent analyzes a failed transaction and decides retry strategy
   */
  async reasonAboutFailure(params: {
    entry: LifecycleEntry;
    failureType: FailureType;
    failureReason: string;
    currentSlot: number;
    tipData: TipData | null;
  }): Promise<RetryDecision> {
    const { entry, failureType, failureReason, currentSlot, tipData } = params;

    const prompt = `You are the failure reasoning module of a Solana transaction stack.

A bundle submission has failed. Analyze the failure and decide the retry strategy.

## Failed Transaction
- Bundle ID: ${entry.bundleId}
- Submitted at slot: ${entry.submittedSlot}
- Current slot: ${currentSlot}
- Slots elapsed: ${currentSlot - entry.submittedSlot}
- Previous tip: ${entry.tipAmount} lamports
- Retry count: ${entry.retryCount}
- Failure type: ${failureType}
- Failure message: ${failureReason}

## Tip Floor Data
${tipData ? `- 50th pct: ${tipData.landed_tips_50th_percentile} SOL\n- 75th pct: ${tipData.landed_tips_75th_percentile} SOL` : "- Unavailable"}

## Failure Type Guide
- expired_blockhash: Blockhash too old (> ~150 slots). MUST refresh blockhash before retry.
- fee_too_low: Priority fee insufficient. Increase tip significantly.
- compute_exceeded: Transaction needs compute budget increase or simplification.
- bundle_failure: Jito-specific issue — often leader skipped or tip too low.
- leader_skipped: Target leader missed their slot. Wait for next Jito leader window.

## Decision Rules
- Max 3 retries — do NOT retry if retryCount >= 3
- expired_blockhash always requires blockhash refresh
- Double tip on fee_too_low failures
- Wait 2-4 slots on leader_skipped failures

Respond in this EXACT JSON format only:
{
  "shouldRetry": <boolean>,
  "newTipLamports": <integer>,
  "refreshBlockhash": <boolean>,
  "waitSlots": <integer>,
  "reasoning": "<2-3 sentence explanation>"
}`;

    try {
      const response = await this.callClaude(prompt);
      const parsed = JSON.parse(response);
      console.log(`[Agent] Retry decision: ${parsed.shouldRetry ? "RETRY" : "ABANDON"}`);
      console.log(`[Agent] Reasoning: ${parsed.reasoning}`);
      return parsed as RetryDecision;
    } catch {
      // Fallback logic
      const shouldRetry = entry.retryCount < 3;
      return {
        shouldRetry,
        newTipLamports: Math.ceil(entry.tipAmount * 1.5),
        refreshBlockhash: failureType === "expired_blockhash",
        waitSlots: 2,
        reasoning: "Fallback retry logic — AI unavailable",
      };
    }
  }

  /**
   * SUBMISSION TIMING - Agent decides whether to submit now or wait
   */
  async decideSubmissionTiming(params: {
    currentSlot: number;
    nextJitoLeaderSlot: number | null;
    slotsUntilLeader: number | null;
    recentSlotLatency: number; // ms between recent slots
    networkHealthScore: number; // 0-100
  }): Promise<TimingDecision> {
    const { currentSlot, nextJitoLeaderSlot, slotsUntilLeader, recentSlotLatency, networkHealthScore } = params;

    const prompt = `You are the submission timing module of a Solana transaction stack.

Decide whether to submit the bundle NOW or wait for better conditions.

## Current State
- Current slot: ${currentSlot}
- Next Jito leader slot: ${nextJitoLeaderSlot ?? "unknown"}
- Slots until next Jito leader: ${slotsUntilLeader ?? "unknown"}
- Recent slot latency: ${recentSlotLatency}ms (normal is ~400ms)
- Network health score: ${networkHealthScore}/100

## Decision Guidelines
- If network health < 50, consider waiting
- If slot latency > 800ms, network is congested — consider waiting
- If next Jito leader is > 10 slots away, submit now anyway (blockhash will expire)
- If Jito leader is 1-3 slots away, wait for optimal window

Respond in this EXACT JSON format only:
{
  "shouldSubmitNow": <boolean>,
  "waitUntilSlot": <integer or null>,
  "reasoning": "<1-2 sentence explanation>"
}`;

    try {
      const response = await this.callClaude(prompt);
      const parsed = JSON.parse(response);
      console.log(`[Agent] Timing: ${parsed.shouldSubmitNow ? "SUBMIT NOW" : `WAIT until slot ${parsed.waitUntilSlot}`}`);
      return parsed as TimingDecision;
    } catch {
      return {
        shouldSubmitNow: true,
        waitUntilSlot: null,
        reasoning: "Fallback: submit immediately — AI unavailable",
      };
    }
  }

  private async callClaude(prompt: string): Promise<string> {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: this.model,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": this.apiKey,
        },
        timeout: 15000,
      }
    );

    const text = response.data.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");

    // Strip markdown fences if present
    return text.replace(/```json\n?|```\n?/g, "").trim();
  }
}
