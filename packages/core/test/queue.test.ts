import { describe, expect, it } from "vitest";
import { InMemoryQueue } from "../src/index.js";

describe("InMemoryQueue", () => {
  it("delivers a message to the handler and records it as processed", async () => {
    const queue = new InMemoryQueue<{ n: number }>();
    const received: number[] = [];
    queue.setHandler(async (msg) => {
      received.push(msg.body.n);
    });

    await queue.send({ n: 1 });

    expect(received).toEqual([1]);
    expect(queue.processed).toEqual([{ n: 1 }]);
    expect(queue.deadLetter).toEqual([]);
  });

  it("retries a failing handler and moves it to the dead letter queue after maxAttempts", async () => {
    const queue = new InMemoryQueue<{ n: number }>({ maxAttempts: 3 });
    let calls = 0;
    queue.setHandler(async () => {
      calls += 1;
      throw new Error("boom");
    });

    await queue.send({ n: 1 });

    expect(calls).toBe(3);
    expect(queue.processed).toEqual([]);
    expect(queue.deadLetter).toHaveLength(1);
    expect(queue.deadLetter[0]?.attempts).toBe(3);
  });

  it("throws if send is called before a handler is registered", async () => {
    const queue = new InMemoryQueue<{ n: number }>();
    await expect(queue.send({ n: 1 })).rejects.toThrow(/setHandler/);
  });
});
