import { EventEmitter } from "node:events";
import type { Opportunity, PlatformHealth } from "../../shared/platform.js";

// In-process event bus (SPEC.md § Platform P0.3). One process, one consumer
// set: loops publish after the row is written, so a subscriber that misses an
// event can always read the durable state. Add a topic by adding a key here.

export interface Topics {
  /** An opportunity row was inserted or moved (after the write). */
  opportunity: { opportunity: Opportunity; change: "created" | "updated" | "status" };
  /** A scan finished: its timestamp and how many assets it covered. */
  scan: { ts: string; assets: number };
  /** WS state change (P0.15 alerts on silence and recovery). */
  ws: { state: PlatformHealth["ws"]["state"]; ts: string };
}

export type Topic = keyof Topics;

/** Typed EventEmitter wrapper. A throwing subscriber is logged and never reaches the publisher. */
export class Bus {
  private readonly ee = new EventEmitter();

  publish<T extends Topic>(topic: T, payload: Topics[T]): void {
    for (const fn of this.ee.listeners(topic)) {
      try {
        (fn as (p: Topics[T]) => void)(payload);
      } catch (err) {
        console.error(`[bus] ${topic} subscriber failed:`, err);
      }
    }
  }

  /** Returns the unsubscribe function. */
  subscribe<T extends Topic>(topic: T, fn: (payload: Topics[T]) => void): () => void {
    this.ee.on(topic, fn);
    return () => void this.ee.off(topic, fn);
  }
}

/** The process-wide bus. */
export const bus = new Bus();
