import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import axios from "axios";

export interface TipData {
  time: string;
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
  ema_landed_tips_50th_percentile: number;
}

export interface BundleResult {
  bundleId: string;
  status: "accepted" | "rejected" | "pending";
  error?: string;
}

export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export class JitoClient {
  private connection: Connection;
  private blockEngineUrl: string;
  private wallet: Keypair;
  private tipAccountIndex: number = 0;

  constructor(connection: Connection, blockEngineUrl: string, wallet: Keypair) {
    this.connection = connection;
    this.blockEngineUrl = blockEngineUrl;
    this.wallet = wallet;
  }

  async fetchTipData(): Promise<TipData | null> {
    try {
      const response = await axios.get(
        "https://bundles.jito.wtf/api/v1/bundles/tip_floor",
        { timeout: 5000 }
      );
      const data = response.data;
      if (Array.isArray(data) && data.length > 0) return data[0] as TipData;
      return null;
    } catch (err: any) {
      console.error("[Jito] Failed to fetch tip data:", err.message);
      return null;
    }
  }

  getNextTipAccount(): string {
    const account = JITO_TIP_ACCOUNTS[this.tipAccountIndex % JITO_TIP_ACCOUNTS.length];
    this.tipAccountIndex++;
    return account;
  }

  async buildBundle(
    transactions: Transaction[],
    tipLamports: number,
    tipAccount: string
  ): Promise<{ serializedBundle: string[]; tipTx: Transaction }> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("confirmed");

    const tipTx = new Transaction();
    tipTx.recentBlockhash = blockhash;
    tipTx.feePayer = this.wallet.publicKey;
    tipTx.add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: tipLamports,
      })
    );
    tipTx.sign(this.wallet);

    for (const tx of transactions) {
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.wallet.publicKey;
      tx.sign(this.wallet);
    }

    const allTxs = [...transactions, tipTx];
    const serializedBundle = allTxs.map((tx) =>
      Buffer.from(tx.serialize()).toString("base64")
    );

    console.log(
      `[Jito] Bundle built | ${allTxs.length} txs | Tip: ${tipLamports} lamports | ` +
      `Blockhash: ${blockhash.slice(0, 12)}... | Valid until block: ${lastValidBlockHeight}`
    );

    return { serializedBundle, tipTx };
  }

  async submitBundle(serializedBundle: string[]): Promise<BundleResult> {
    try {
      const response = await axios.post(
        `${this.blockEngineUrl}/api/v1/bundles`,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [serializedBundle],
        },
        { headers: { "Content-Type": "application/json" }, timeout: 15000 }
      );

      const bundleId = response.data?.result;
      if (bundleId) {
        console.log(`[Jito] Bundle submitted ✓ | ID: ${bundleId}`);
        return { bundleId, status: "accepted" };
      }

      const error = response.data?.error?.message || "Unknown error";
      console.error(`[Jito] Bundle rejected: ${error}`);
      return { bundleId: "", status: "rejected", error };
    } catch (err: any) {
      const message = err.response?.data?.error?.message || err.message;
      console.error(`[Jito] Submission failed: ${message}`);
      return { bundleId: "", status: "rejected", error: message };
    }
  }

  async getBundleStatus(bundleId: string): Promise<string> {
    try {
      const response = await axios.post(
        `${this.blockEngineUrl}/api/v1/bundles`,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getBundleStatuses",
          params: [[bundleId]],
        },
        { timeout: 10000 }
      );
      const statuses = response.data?.result?.value;
      if (statuses && statuses.length > 0) return statuses[0]?.confirmation_status || "unknown";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  async refreshBlockhash(transactions: Transaction[]): Promise<string> {
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    for (const tx of transactions) {
      tx.recentBlockhash = blockhash;
      tx.signatures = [];
      tx.sign(this.wallet);
    }
    console.log(`[Jito] Blockhash refreshed: ${blockhash.slice(0, 12)}...`);
    return blockhash;
  }

  async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return balance / LAMPORTS_PER_SOL;
  }
}
