export type { EmailMessage, EmailProvider, EmailSendResult } from "./provider.js";
export { MockEmailProvider } from "./providers/mockProvider.js";
export { ResendEmailProvider, type ResendConfig } from "./providers/resendProvider.js";
export {
  renderInvitationEmail,
  type InvitationEmailInput,
  type RenderedEmail,
} from "./invitationEmail.js";
