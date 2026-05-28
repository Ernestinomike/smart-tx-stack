import { EventEmitter } from "events";
import axios from "axios";

export interface SlotInfo {
  slot: number;
  parent: number;
  status: "processed" | "confirmed" | "finalized";
  timestamp: number;
}

export class SlotStream extends EventEmitter {
  private rpcUrl: string;
  private geyserEndpoint: string | undefined;
  private geyserToken: string | undefined;
  private currentSlot: number = 0;
  private isRunning: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;

  constructor(rpcUrl: string, geyserEndpoint?: string, geyserToken?: string) {
    super();
    this.rpcUrl = rpcUrl;
    this.geyserEndpoint = geyserEndpoint;
    this.geyserToken = geyserToken;
  }

  async start(): Promise<void> {
    this.isRunning = true;
    console.log("[SlotStream] Starting slot monitor...");
    if (this.geyserEndpoint && this.geyserToken) {
      await this.startGeyserStream();
    } else {
      console.log("[SlotStream] No Geyser endpoint — falling back to RPC polling");
      await this.startRpcPolling();
    }
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log("[SlotStream] Stopped.");
  }

  getCurrentSlot(): number {
    return this.currentSlot;
  }

  private async startGeyserStream(): Promise<void> {
    const subscribe = async () => {
      try {
        console.log(`[SlotStream] Connecting to Yellowstone gRPC: ${this.geyserEndpoint}`);
        const response = await axios.post(
          `${this.geyserEndpoint}/subscribe`,
          { slots: { "": {} } },
          {
            headers: {
              Authorization: `Bearer ${this.geyserToken}`,
              "Content-Type": "application/json",
            },
            responseType: "stream",
            timeout: 30000,
          }
        );
        this.reconnectAttempts = 0;
        console.log("[SlotStream] Yellowstone stream connected ✓");

        response.data.on("data", (chunk: Buffer) => {
          try {
            const lines = chunk.toString().split("\n").filter(Boolean);
            for (const line of lines) {
              const update = JSON.parse(line);
              if (update.slot) this.handleSlotUpdate(update.slot);
            }
          } catch { /* partial chunk */ }
        });

        response.data.on("end", () => {
          console.log("[SlotStream] Stream ended — reconnecting...");
          this.scheduleReconnect(subscribe);
        });

        response.data.on("error", (err: Error) => {
          console.error("[SlotStream] Stream error:", err.message);
          this.scheduleReconnect(subscribe);
        });
      } catch (err: any) {
        console.error("[SlotStream] Geyser connection failed:", err.message);
        this.scheduleReconnect(subscribe);
      }
    };
    await subscribe();
  }

  private async startRpcPolling(): Promise<void> {
    const poll = async () => {
      if (!this.isRunning) return;
      try {
        const response = await axios.post(
          this.rpcUrl,
          { jsonrpc: "2.0", id: 1, method: "getSlot", params: [{ commitment: "processed" }] },
          { timeout: 5000 }
        );
        const slot = response.data?.result;
        if (slot && slot !== this.currentSlot) {
          this.handleSlotUpdate({ slot, status: "processed" });
        }
      } catch { /* silent */ }
    };
    await poll();
    this.pollInterval = setInterval(poll, 400);
  }

  private handleSlotUpdate(update: { slot: number; status?: string }): void {
    this.currentSlot = update.slot;
    const slotInfo: SlotInfo = {
      slot: update.slot,
      parent: update.slot - 1,
      status: (update.status as SlotInfo["status"]) || "processed",
      timestamp: Date.now(),
    };
    this.emit("slot", slotInfo);
    if (slotInfo.status === "confirmed") this.emit("confirmed", slotInfo);
    if (slotInfo.status === "finalized") this.emit("finalized", slotInfo);
  }

  private scheduleReconnect(fn: () => Promise<void>): void {
    if (!this.isRunning) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.log("[SlotStream] Max retries reached — switching to RPC polling");
      this.startRpcPolling();
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`[SlotStream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    setTimeout(fn, delay);
  }

  async getLeaderSchedule(): Promise<Map<string, number[]>> {
    try {
      const response = await axios.post(
        this.rpcUrl,
        { jsonrpc: "2.0", id: 1, method: "getLeaderSchedule", params: [] },
        { timeout: 10000 }
      );
      const schedule = response.data?.result || {};
      const map = new Map<string, number[]>();
      for (const [leader, slots] of Object.entries(schedule)) {
        map.set(leader, slots as number[]);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  waitForSlot(targetSlot: number): Promise<SlotInfo> {
    return new Promise((resolve) => {
      if (this.currentSlot >= targetSlot) {
        resolve({ slot: this.currentSlot, parent: this.currentSlot - 1, status: "processed", timestamp: Date.now() });
        return;
      }
      const handler = (info: SlotInfo) => {
        if (info.slot >= targetSlot) {
          this.off("slot", handler);
          resolve(info);
        }
      };
      this.on("slot", handler);
    });
  }
}
