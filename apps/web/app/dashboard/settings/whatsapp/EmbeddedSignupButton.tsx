"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Meta Embedded Signup, client half (Batch 3, Slice C). This component:
 *  - loads Meta's own Facebook JS SDK and drives its FB.login popup with
 *    this app's real, verified config_id (NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID)
 *    -- never a hardcoded or invented value;
 *  - NEVER exchanges the returned authorization code itself -- the code
 *    (and the waba_id/phone_number_id/business_id Meta reports via
 *    postMessage) are sent, over HTTPS, to this app's own authenticated
 *    backend (/api/integrations/meta/whatsapp/signup/complete), which does
 *    the real exchange and Graph API verification server-side;
 *  - never receives, stores, or displays an access token at any point --
 *    there is no token anywhere in this component's code path;
 *  - keeps the one-time signup nonce (from .../signup/initiate) in a plain
 *    in-memory ref only, never localStorage/sessionStorage/a cookie.
 */

interface FacebookLoginAuthResponse {
  code?: string;
}

interface FacebookLoginResponse {
  authResponse?: FacebookLoginAuthResponse;
  status?: string;
}

interface FacebookSdk {
  init(config: { appId: string; version: string; xfbml?: boolean }): void;
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: {
      config_id: string;
      response_type: "code";
      override_default_response_type: true;
      extras: { version: "v4" };
    },
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

interface SignupEventData {
  wabaId: string | null;
  phoneNumberId: string | null;
  businessId: string | null;
}

function isMetaOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "facebook.com" || hostname.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

type ConnectStatus = "idle" | "opening" | "completing" | "connected";

const FB_SDK_GRAPH_VERSION = "v21.0";

export function EmbeddedSignupButton({
  hasExistingConnection,
}: {
  hasExistingConnection: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<ConnectStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sdkReady, setSdkReady] = useState(false);

  const attemptRef = useRef<{ attemptId: string; nonce: string } | null>(null);
  const codeRef = useRef<string | null>(null);
  const signupDataRef = useRef<SignupEventData | null>(null);

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const configId = process.env.NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID;

  useEffect(() => {
    if (typeof window === "undefined" || !appId) return;
    if (window.FB) {
      setSdkReady(true);
      return;
    }
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, version: FB_SDK_GRAPH_VERSION });
      setSdkReady(true);
    };
    const existingScript = document.getElementById("facebook-jssdk");
    if (existingScript) return;
    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    document.body.appendChild(script);
  }, [appId]);

  const resetAttempt = useCallback(() => {
    attemptRef.current = null;
    codeRef.current = null;
    signupDataRef.current = null;
  }, []);

  const tryComplete = useCallback(async () => {
    const attempt = attemptRef.current;
    const code = codeRef.current;
    const signupData = signupDataRef.current;
    if (!attempt || !code || !signupData) return; // still waiting on one of the two async signals

    if (!signupData.wabaId || !signupData.phoneNumberId) {
      setStatus("idle");
      setError(
        "Meta did not report a WhatsApp Business Account and phone number. Please try again.",
      );
      resetAttempt();
      return;
    }

    setStatus("completing");
    try {
      const response = await fetch("/api/integrations/meta/whatsapp/signup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attemptId: attempt.attemptId,
          nonce: attempt.nonce,
          code,
          wabaId: signupData.wabaId,
          phoneNumberId: signupData.phoneNumberId,
          businessId: signupData.businessId,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? "Unable to complete WhatsApp connection.");
      }
      setStatus("connected");
      resetAttempt();
      router.refresh();
    } catch (completeError) {
      setStatus("idle");
      setError(
        completeError instanceof Error
          ? completeError.message
          : "Unable to complete WhatsApp connection.",
      );
      resetAttempt();
    }
  }, [resetAttempt, router]);

  useEffect(() => {
    function handleMessage(event: MessageEvent): void {
      if (!isMetaOrigin(event.origin)) return;

      let payload: unknown;
      if (typeof event.data === "string") {
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
      } else {
        payload = event.data;
      }

      if (typeof payload !== "object" || payload === null) return;
      const message = payload as {
        type?: unknown;
        event?: unknown;
        data?: Record<string, unknown>;
      };
      if (message.type !== "WA_EMBEDDED_SIGNUP") return;

      if (message.event === "FINISH") {
        const data = message.data ?? {};
        signupDataRef.current = {
          wabaId: typeof data.waba_id === "string" ? data.waba_id : null,
          phoneNumberId: typeof data.phone_number_id === "string" ? data.phone_number_id : null,
          businessId: typeof data.business_id === "string" ? data.business_id : null,
        };
        void tryComplete();
      } else if (message.event === "CANCEL") {
        setStatus("idle");
        setError("WhatsApp connection was cancelled.");
        resetAttempt();
      } else if (message.event === "ERROR") {
        setStatus("idle");
        setError("Meta reported an error during WhatsApp setup. Please try again.");
        resetAttempt();
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [resetAttempt, tryComplete]);

  const startConnect = useCallback(async () => {
    if (!window.FB || !configId) {
      setError("WhatsApp connection is not available right now.");
      return;
    }
    setError(null);
    setStatus("opening");
    resetAttempt();

    try {
      const response = await fetch("/api/integrations/meta/whatsapp/signup/initiate", {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        attemptId?: string;
        nonce?: string;
        error?: string;
      };
      if (!response.ok || !body.attemptId || !body.nonce) {
        throw new Error(body.error ?? "Unable to start WhatsApp connection.");
      }
      attemptRef.current = { attemptId: body.attemptId, nonce: body.nonce };
    } catch (initiateError) {
      setStatus("idle");
      setError(
        initiateError instanceof Error
          ? initiateError.message
          : "Unable to start WhatsApp connection.",
      );
      return;
    }

    window.FB.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          setStatus("idle");
          setError("WhatsApp connection was cancelled.");
          resetAttempt();
          return;
        }
        codeRef.current = code;
        void tryComplete();
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { version: "v4" },
      },
    );
  }, [configId, resetAttempt, tryComplete]);

  if (!appId || !configId) {
    return null; // Embedded Signup is not configured for this environment -- no button, no broken flow.
  }

  return (
    <div>
      <button
        type="button"
        className="dvx-button"
        disabled={!sdkReady || status === "opening" || status === "completing"}
        onClick={() => void startConnect()}
      >
        {status === "opening" || status === "completing"
          ? "Connecting…"
          : hasExistingConnection
            ? "Reconnect WhatsApp"
            : "Connect WhatsApp"}
      </button>
      {error ? (
        <p
          className="dvx-muted"
          style={{ color: "#b42318", fontSize: "0.85rem", marginTop: "0.5rem" }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
