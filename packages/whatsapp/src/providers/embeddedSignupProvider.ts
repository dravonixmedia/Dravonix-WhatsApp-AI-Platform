import { WhatsAppProviderError } from "./graphApiProvider.js";

/**
 * Every Graph API call this module makes throws this subclass instead of
 * the bare `WhatsAppProviderError` -- it carries two additional fields Meta's
 * standard error envelope provides (`error.type`, `error.error_data.details`)
 * that a bare `WhatsAppProviderError` cannot express. Deliberately declared
 * here, not on the shared `WhatsAppProviderError` class itself (used by the
 * separate send-path provider and the AI outbound pipeline) -- this keeps
 * the additional fields scoped to Embedded Signup's own diagnostics, with
 * zero change to that unrelated call surface. `.name` is left as
 * "WhatsAppProviderError" (not this subclass's own name) so the existing
 * `providerErrorType` diagnostic field -- already shipped as a stable
 * classification value -- is unaffected; `metaErrorType`/`errorDetail` are
 * new, separate fields for the two new pieces of information.
 */
export class MetaGraphApiError extends WhatsAppProviderError {
  constructor(
    message: string,
    status: number,
    errorCode: string | undefined,
    errorSubcode: string | undefined,
    /** Meta's own `error.type` (e.g. "OAuthException", "GraphMethodException"), when present. */
    public readonly metaErrorType?: string,
    /** Meta's own `error.error_data.details` -- a short, Meta-authored clarification string, when present. */
    public readonly errorDetail?: string,
  ) {
    super(message, status, errorCode, errorSubcode);
    this.name = "WhatsAppProviderError";
  }
}

/**
 * Meta Graph API primitives for WhatsApp Embedded Signup (Batch 3, Slice B).
 *
 * This module is deliberately narrow: it exposes typed, individually testable
 * operations against Meta's Graph API (OAuth code exchange, token
 * inspection, WABA/phone metadata, phone registration, app subscription).
 * It does NOT decide anything about DRAIVA's own data model -- it never
 * writes to whatsapp_accounts/whatsapp_signup_attempts, never checks tenant
 * permissions, and never decides whether a signup should be accepted. That
 * composition (claiming a signup attempt, persisting an encrypted token,
 * flipping connection_source) is Slice C's job, not this one.
 *
 * Every credential (authorization code, access token being exchanged/
 * inspected, app secret) is passed as an explicit function/constructor
 * argument -- never read from a module-level global or env var here -- and
 * NEVER appears in a thrown error's message. `WhatsAppProviderError` (the
 * same class the existing send-path provider already uses) only ever
 * carries {message, status, errorCode, errorSubcode}: never a raw request
 * body, raw response body, or query string.
 *
 * Contract confidence: the endpoints and field names below reflect Meta's
 * long-stable, versioned Graph API surface (these shapes have not changed
 * across API versions for years -- only the version number in the URL
 * changes) and are cross-checked against multiple independent, current
 * sources.
 *
 * `exchangeEmbeddedSignupCode`'s request shape (POST, JSON body,
 * `grant_type: "authorization_code"`, `client_id`/`client_secret`/`code`
 * only) targets app "Dravonix Bot", Facebook Login for Business
 * configuration "DRAIVA WhatsApp Signup" (config_id 2509972019488744),
 * Embedded Signup v4, Session Info Version 3, System User access token.
 *
 * CORRECTION (originally shipped with a `redirect_uri` field, removed after
 * a real staging failure): the browser-side flow drives Meta's popup via
 * the JS SDK's `FB.login()` (see EmbeddedSignupButton.tsx) -- it never
 * supplies, and the JS SDK never associates, an app-configured redirect URI
 * with that authorization request, since it is a popup flow, not a
 * page-redirect flow. Sending our own `META_EMBEDDED_SIGNUP_REDIRECT_URI`
 * value in the exchange call therefore did not match the (absent) redirect
 * URI Meta associated with the original authorization, and Meta's OAuth
 * validation rejects that mismatch: a real staging attempt failed with
 * `error.code=100`, `error.error_subcode=36008` -- Meta's own "redirect URI
 * does not match" family of `OAuthException` -- confirmed via this
 * project's own sanitized diagnostics capture (EmbeddedSignupFlowError,
 * see embeddedSignupFlow.ts). `redirect_uri` is therefore correctly omitted
 * from this call for this app's popup-based (`FB.login()`) Embedded Signup
 * configuration; this is scoped specifically to that flow, not a general
 * claim about every Meta OAuth flow -- a manual full-page-redirect OAuth
 * flow elsewhere in the project (if any is ever added) would still need its
 * own matching `redirect_uri`, independent of this decision.
 *
 * RESOLVED (was previously called out here as unresolved): the phone
 * registration PIN requirement. A real staging attempt against the Meta
 * Sandbox WhatsApp Business Account (Embedded Signup, no PIN supplied)
 * failed at `/register` with `error.code=100`, `error.type="OAuthException"`,
 * no subcode, no `error_data.details` -- Meta's generic invalid-parameter
 * signal, consistent with (though not itself proof of) a missing required
 * parameter. Meta's documented WhatsApp Business Platform phone-registration
 * contract requires `pin` (a 6-digit string) in this request body, alongside
 * `messaging_product`, both to register the number and to set its two-step
 * verification PIN. CORRECTION #2: an initial "generate a fresh PIN on every
 * call" design (PR #74) was itself proven wrong by a real staging attempt --
 * Meta rejects re-registering an already-registered number with a different
 * PIN than the one already set (error.code=133005, "Security PIN mismatch").
 * The caller (embeddedSignupFlow.ts's completeEmbeddedSignup, via
 * reserveOrReuseRegistrationPin) now durably persists a PIN BEFORE ever
 * sending it here, and reuses that same persisted PIN on every subsequent
 * call for the same phone number -- never regenerating one blindly.
 * `registerPhoneNumber` below still treats `pin` as an optional pass-through
 * parameter and never invents its own default -- generation/persistence is
 * entirely the caller's responsibility -- so this module's own contract is
 * unchanged; only its caller's behavior changed.
 */

/** Credentials for the Meta App itself (not a specific WABA/user token) -- needed only for the OAuth code exchange and token inspection, per Meta's documented "app access token" model. */
export interface MetaAppCredentials {
  appId: string;
  appSecret: string;
  graphApiVersion: string;
  /** Overridable for tests; defaults to the real Meta Graph API host. */
  baseUrl?: string;
}

export interface ExchangeEmbeddedSignupCodeResult {
  accessToken: string;
  /** Present when Meta's response included one; never fabricated when absent (e.g. some token types are returned without an expires_in field). */
  expiresInSeconds: number | null;
  /** Meta's own `token_type` field verbatim (typically "bearer"), when present. */
  tokenType: string | null;
}

/**
 * Input for `exchangeEmbeddedSignupCode`. No `redirectUri` field -- see this
 * module's own doc comment for why: the popup-based `FB.login()` flow this
 * app uses never associates a redirect URI with the authorization request
 * in the first place, and sending one anyway (this module's original
 * shape) caused Meta to reject the exchange (`error.code=100`,
 * `error.error_subcode=36008`) against a real staging attempt.
 */
export interface ExchangeEmbeddedSignupCodeInput extends MetaAppCredentials {
  code: string;
}

/**
 * Exchanges a WhatsApp Embedded Signup authorization code for an access
 * token via Meta's OAuth token endpoint.
 *
 * Request shape (`POST /oauth/access_token`, `Content-Type: application/json`,
 * body `{client_id, client_secret, grant_type: "authorization_code", code}`,
 * deliberately no `redirect_uri`) targets this app's actual "DRAIVA WhatsApp
 * Signup" (Embedded Signup v4, popup/`FB.login()`-based) configuration --
 * see this module's own doc comment for why `redirect_uri` is omitted. This
 * is NOT a generic claim about every Meta OAuth flow; it is scoped to this
 * specific configuration's exchange step.
 *
 * `code` and `appSecret` are sent only in this request's own JSON body and
 * never appear in any thrown error -- a failure throws a
 * WhatsAppProviderError with a static, redacted message naming only the
 * operation, never the request body.
 */
export async function exchangeEmbeddedSignupCode(
  input: ExchangeEmbeddedSignupCodeInput,
): Promise<ExchangeEmbeddedSignupCodeResult> {
  const baseUrl = input.baseUrl ?? `https://graph.facebook.com/${input.graphApiVersion}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: input.appId,
        client_secret: input.appSecret,
        grant_type: "authorization_code",
        code: input.code,
      }),
    });
  } catch {
    throw new WhatsAppProviderError("Meta embedded signup code exchange request failed", 502);
  }

  if (!response.ok) {
    const errorCode = await extractErrorCode(response);
    throw new MetaGraphApiError(
      "Meta embedded signup code exchange failed",
      response.status,
      errorCode.code,
      errorCode.subcode,
      errorCode.type,
      errorCode.detail,
    );
  }

  const body = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
  } | null;

  if (!body || typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new WhatsAppProviderError(
      "Meta embedded signup code exchange returned no access token",
      502,
    );
  }

  return {
    accessToken: body.access_token,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : null,
    tokenType: typeof body.token_type === "string" ? body.token_type : null,
  };
}

export interface InspectAccessTokenResult {
  isValid: boolean;
  /** The Meta App ID this token was actually issued for -- callers MUST compare this against their own expected app id rather than trusting the token's origin implicitly. */
  appId: string | null;
  /**
   * Unix seconds, or null when Meta's response did not include the field at
   * all. A present value of 0 means "does not expire" (Meta's own
   * convention for e.g. permanent System User tokens) and is returned
   * as-is -- never normalized or reinterpreted here.
   */
  expiresAt: number | null;
  scopes: string[];
}

/**
 * Inspects an access token via Meta's `/debug_token` endpoint. Requires an
 * app access token (this app's own `{appId}|{appSecret}` credential, per
 * Meta's documented app-access-token format) to authenticate the inspection
 * call itself -- distinct from `tokenToInspect`, the token being examined.
 *
 * Neither `tokenToInspect` nor the app access token ever appears in a
 * thrown error.
 */
export async function inspectAccessToken(
  credentials: MetaAppCredentials,
  tokenToInspect: string,
): Promise<InspectAccessTokenResult> {
  const baseUrl =
    credentials.baseUrl ?? `https://graph.facebook.com/${credentials.graphApiVersion}`;
  const appAccessToken = `${credentials.appId}|${credentials.appSecret}`;
  const url = new URL(`${baseUrl}/debug_token`);
  url.searchParams.set("input_token", tokenToInspect);
  url.searchParams.set("access_token", appAccessToken);

  let response: Response;
  try {
    response = await fetch(url.toString(), { method: "GET" });
  } catch {
    throw new WhatsAppProviderError("Meta access token inspection request failed", 502);
  }

  if (!response.ok) {
    const errorCode = await extractErrorCode(response);
    throw new MetaGraphApiError(
      "Meta access token inspection failed",
      response.status,
      errorCode.code,
      errorCode.subcode,
      errorCode.type,
      errorCode.detail,
    );
  }

  const body = (await response.json().catch(() => null)) as {
    data?: {
      is_valid?: unknown;
      app_id?: unknown;
      expires_at?: unknown;
      scopes?: unknown;
    };
  } | null;

  const data = body?.data;
  if (!data || typeof data.is_valid !== "boolean") {
    throw new WhatsAppProviderError(
      "Meta access token inspection returned a malformed response",
      502,
    );
  }

  return {
    isValid: data.is_valid,
    appId: typeof data.app_id === "string" ? data.app_id : null,
    expiresAt: typeof data.expires_at === "number" ? data.expires_at : null,
    scopes: Array.isArray(data.scopes)
      ? data.scopes.filter((s): s is string => typeof s === "string")
      : [],
  };
}

/** Config for calls authenticated with a bearer WABA/user access token (not the app-level credentials above). */
export interface MetaGraphManagementConfig {
  accessToken: string;
  graphApiVersion: string;
  /** Overridable for tests; defaults to the real Meta Graph API host. */
  baseUrl?: string;
}

export interface WhatsAppBusinessAccountMetadata {
  id: string;
  name: string | null;
  currency: string | null;
  timezoneId: string | null;
  messageTemplateNamespace: string | null;
}

export interface WhatsAppPhoneNumberMetadata {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  qualityRating: string | null;
}

export interface RegisterPhoneNumberResult {
  success: boolean;
}

export interface SubscribeAppToWabaResult {
  success: boolean;
}

export interface VerifyAppSubscriptionResult {
  subscribed: boolean;
  subscribedAppIds: string[];
}

/**
 * Meta Graph API management operations authenticated with a bearer access
 * token (the token returned by `exchangeEmbeddedSignupCode`, or the
 * existing global META_ACCESS_TOKEN for read-only staging probes). Mirrors
 * GraphApiWhatsAppProvider's request/error conventions exactly -- the token
 * only ever appears in the Authorization header, never in a URL, so it is
 * structurally impossible for it to leak into a thrown error's message the
 * way this class builds errors (path-only, no query/body reflected).
 */
export class MetaGraphManagementClient {
  private readonly baseUrl: string;

  constructor(private readonly config: MetaGraphManagementConfig) {
    this.baseUrl = config.baseUrl ?? `https://graph.facebook.com/${config.graphApiVersion}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new WhatsAppProviderError(`Meta Graph API request to ${path} failed`, 502);
    }

    if (!response.ok) {
      const errorCode = await extractErrorCode(response);
      throw new MetaGraphApiError(
        `Meta Graph API request to ${path} failed with status ${response.status}`,
        response.status,
        errorCode.code,
        errorCode.subcode,
        errorCode.type,
        errorCode.detail,
      );
    }

    return response.json().catch(() => ({}));
  }

  /** `GET /{waba-id}` -- basic WABA metadata. */
  async getWhatsAppBusinessAccount(wabaId: string): Promise<WhatsAppBusinessAccountMetadata> {
    const data = (await this.request(
      `/${wabaId}?fields=id,name,currency,timezone_id,message_template_namespace`,
    )) as {
      id?: unknown;
      name?: unknown;
      currency?: unknown;
      timezone_id?: unknown;
      message_template_namespace?: unknown;
    };
    if (typeof data.id !== "string") {
      throw new WhatsAppProviderError("Meta WABA metadata response was malformed", 502);
    }
    return {
      id: data.id,
      name: typeof data.name === "string" ? data.name : null,
      currency: typeof data.currency === "string" ? data.currency : null,
      timezoneId: typeof data.timezone_id === "string" ? data.timezone_id : null,
      messageTemplateNamespace:
        typeof data.message_template_namespace === "string"
          ? data.message_template_namespace
          : null,
    };
  }

  /**
   * `GET /{waba-id}/phone_numbers` -- every phone number Meta itself
   * considers owned by this WABA. This is the authoritative list used by
   * `verifyPhoneBelongsToWaba` below; it is never derived from an ID a
   * browser client supplied.
   */
  async getPhoneNumbersForWaba(wabaId: string): Promise<WhatsAppPhoneNumberMetadata[]> {
    const data = (await this.request(
      `/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
    )) as {
      data?: Array<{
        id?: unknown;
        display_phone_number?: unknown;
        verified_name?: unknown;
        quality_rating?: unknown;
      }>;
    };
    if (!Array.isArray(data.data)) {
      throw new WhatsAppProviderError("Meta WABA phone number list response was malformed", 502);
    }
    return data.data
      .filter(
        (entry): entry is { id: string; display_phone_number: string } & typeof entry =>
          typeof entry.id === "string" && typeof entry.display_phone_number === "string",
      )
      .map((entry) => ({
        id: entry.id,
        displayPhoneNumber: entry.display_phone_number,
        verifiedName: typeof entry.verified_name === "string" ? entry.verified_name : null,
        qualityRating: typeof entry.quality_rating === "string" ? entry.quality_rating : null,
      }));
  }

  /**
   * Proves -- via Meta's own WABA->phone-numbers relationship, never by
   * trusting a browser-supplied pairing -- that `phoneNumberId` is actually
   * one of `wabaId`'s own phone numbers. This is the authorization check
   * required before DRAIVA ever treats a (wabaId, phoneNumberId) pair
   * supplied during an Embedded Signup flow as real.
   */
  async verifyPhoneBelongsToWaba(wabaId: string, phoneNumberId: string): Promise<boolean> {
    const phoneNumbers = await this.getPhoneNumbersForWaba(wabaId);
    return phoneNumbers.some((phoneNumber) => phoneNumber.id === phoneNumberId);
  }

  /**
   * `POST /{phone-number-id}/register`. `pin` is optional at this layer and
   * passed through verbatim when the caller supplies one -- this function
   * itself never invents, defaults, or requires a PIN; Meta's documented
   * contract does require one, but generating it is the caller's job (see
   * embeddedSignupFlow.ts's generateRegistrationPin and this module's own
   * top-of-file doc comment). A non-2xx response (e.g. a rejected or missing
   * PIN) surfaces as a WhatsAppProviderError/MetaGraphApiError with Meta's
   * own error code/subcode/type intact for the caller to inspect -- this
   * function does not swallow or reinterpret that signal.
   */
  async registerPhoneNumber(
    phoneNumberId: string,
    pin?: string,
  ): Promise<RegisterPhoneNumberResult> {
    const data = (await this.request(`/${phoneNumberId}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...(pin !== undefined ? { pin } : {}),
      }),
    })) as { success?: unknown };
    return { success: data.success === true };
  }

  /**
   * `POST /{waba-id}/subscribed_apps` -- subscribes this app (identified by
   * the bearer token's own app, per Meta's convention) to receive webhooks
   * for this WABA. Calling this when already subscribed is a documented
   * safe no-op on Meta's side (repeated subscription does not error); this
   * function does not itself special-case that, it simply reports whatever
   * `success` value Meta's response contains.
   */
  async subscribeAppToWaba(wabaId: string): Promise<SubscribeAppToWabaResult> {
    const data = (await this.request(`/${wabaId}/subscribed_apps`, {
      method: "POST",
    })) as { success?: unknown };
    return { success: data.success === true };
  }

  /**
   * `GET /{waba-id}/subscribed_apps` -- lists every app currently
   * subscribed to this WABA's webhooks, so a caller can confirm
   * `subscribeAppToWaba` actually took effect rather than trusting its own
   * `success: true` response in isolation.
   */
  async verifyAppSubscription(
    wabaId: string,
    expectedAppId: string,
  ): Promise<VerifyAppSubscriptionResult> {
    const data = (await this.request(`/${wabaId}/subscribed_apps`)) as {
      data?: Array<{ whatsapp_business_api_data?: { id?: unknown } }>;
    };
    const subscribedAppIds = Array.isArray(data.data)
      ? data.data
          .map((entry) => entry.whatsapp_business_api_data?.id)
          .filter((id): id is string => typeof id === "string")
      : [];
    return {
      subscribed: subscribedAppIds.includes(expectedAppId),
      subscribedAppIds,
    };
  }
}

/**
 * Extracts Meta's {error.code, error.error_subcode, error.type,
 * error.error_data.details} from a failed response body -- the same four
 * fields Meta's Graph API error envelope has carried for years across every
 * product (this shape itself is long-stable and well-documented; it is not
 * specific to Embedded Signup). Never returns or logs anything else from the
 * body -- no `error.message` (can echo request specifics), no
 * `error.fbtrace_id`, no raw body.
 */
async function extractErrorCode(response: Response): Promise<{
  code: string | undefined;
  subcode: string | undefined;
  type: string | undefined;
  detail: string | undefined;
}> {
  const body = await response.json().catch(() => ({}));
  const apiError = (
    body as {
      error?: {
        code?: string | number;
        error_subcode?: string | number;
        type?: string;
        error_data?: { details?: string };
      };
    }
  )?.error;
  return {
    code: apiError?.code !== undefined ? String(apiError.code) : undefined,
    subcode: apiError?.error_subcode !== undefined ? String(apiError.error_subcode) : undefined,
    type: typeof apiError?.type === "string" ? apiError.type : undefined,
    detail:
      typeof apiError?.error_data?.details === "string" ? apiError.error_data.details : undefined,
  };
}
