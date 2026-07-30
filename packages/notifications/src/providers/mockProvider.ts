import type {
  NotificationInput,
  NotificationProvider,
  NotificationSendResult,
} from "../notification.js";

/** In-memory notification provider for local dev and tests. */
export class MockNotificationProvider implements NotificationProvider {
  readonly sent: NotificationInput[] = [];

  async send(input: NotificationInput): Promise<NotificationSendResult> {
    this.sent.push(input);
    return { sent: true };
  }
}
