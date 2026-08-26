export type { EmailMessage, EmailProvider, EmailSendResult } from "./provider.js";
export { MockEmailProvider } from "./providers/mockProvider.js";
export { ZeptoMailEmailProvider, type ZeptoMailConfig } from "./providers/zeptoMailProvider.js";
export {
  renderInvitationEmail,
  type InvitationEmailInput,
  type RenderedEmail,
} from "./invitationEmail.js";
export {
  renderNewSupportRequestEmail,
  type SupportRequestTypeLabelInput,
} from "./supportRequestEmail.js";
export { renderSupportReplyEmail, type SupportReplyEmailInput } from "./supportReplyEmail.js";
export {
  renderBillingReminderEmail,
  type BillingReminderEmailInput,
  type BillingReminderStage,
} from "./billingReminderEmail.js";
