import type { QueueSender } from "@dravonix/core";

export class FakeQueueSender<T> implements QueueSender<T> {
  readonly sent: T[] = [];

  async send(body: T): Promise<void> {
    this.sent.push(body);
  }
}
