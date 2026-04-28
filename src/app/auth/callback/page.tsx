/**
 * /auth/callback — temporary placeholder OAuth-callback receiver.
 *
 * Reference: docs/design/WALLET-MOBILE-AUTH-FLOW.md §10.2 (semantos-core repo)
 *            docs/design/WALLET-LEGACY-INGEST.md §3 LI1 deliverable 2
 *            docs/design/V1.0-EXECUTION-PLAN.md §5
 *
 * Per the V1.0 plan §5: until the WSH HTTP surface ships and `auth/callback`
 * moves to WSITE3, the operator's legacy-provider OAuth grant flow uses
 * THIS Vercel deployment as a temporary callback receiver.
 *
 * Architectural rationale: the operator's OAuth grant orchestrator
 * (runtime/legacy-ingest/src/oauth.ts) runs on the operator's local node,
 * holding pending state nonces in memory. It cannot directly receive a
 * provider's HTTP redirect — Google / Meta / Xero need a publicly-reachable
 * callback URL. Vercel + this Next.js app already serve oddjobtodd.info
 * under TLS, so they're the cheapest publicly-reachable host until the
 * sovereign-node HTTP surface lands.
 *
 * The handoff: Vercel receives the redirect, displays the (state, code)
 * pair to the operator with a copy-paste-friendly UI, and the operator
 * runs `legacy resume <state> <code>` in their local REPL. The local
 * orchestrator then verifies the state nonce + exchanges the code with
 * the provider.
 *
 * Security:
 *   - Server side never logs the auth code (it's short-lived but valid;
 *     leaking it gives an attacker the same window the operator has).
 *   - This route is rendered as a Server Component but never persists or
 *     forwards the code anywhere off-device.
 *   - Provider error responses (`error=access_denied` etc.) are surfaced
 *     to the operator without further processing.
 *
 * Once stage 2 (WSITE) ships, this file is deleted and the callback
 * moves under the operator's wallet origin.
 */

import CopyButton from "./CopyButton";

interface Props {
  searchParams: Promise<{
    purpose?: string;
    provider?: string;
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }>;
}

export const metadata = {
  title: "OAuth Callback — oddjobtodd",
  description: "Legacy-provider OAuth callback handoff (operator-only).",
};

// Force this page to render dynamically — query params drive the output.
export const dynamic = "force-dynamic";

export default async function OAuthCallbackPage({ searchParams }: Props) {
  const params = await searchParams;
  const purpose = params.purpose ?? "unknown";

  // Branch on purpose. Mobile auth flow uses other purpose values; legacy
  // ingest uses 'oauth_grant'. Anything else is unhandled here.
  if (purpose !== "oauth_grant") {
    return (
      <Page heading="Unsupported callback purpose">
        <p>
          This URL was opened with <code>purpose={purpose}</code>, which this
          temporary callback handler does not recognise. If you were trying to
          connect a legacy provider (Gmail, Meta, WhatsApp Cloud, Google
          Calendar, Xero), the URL should include <code>purpose=oauth_grant</code>.
        </p>
      </Page>
    );
  }

  // Provider returned an error response.
  if (params.error) {
    return (
      <Page heading={`OAuth error from ${params.provider ?? "provider"}`}>
        <p>
          The provider rejected the grant request. Run{" "}
          <code>semantos legacy connect {params.provider ?? "<provider>"}</code>{" "}
          again to retry.
        </p>
        <CodeBlock label="error">{params.error}</CodeBlock>
        {params.error_description ? (
          <CodeBlock label="error_description">{params.error_description}</CodeBlock>
        ) : null}
      </Page>
    );
  }

  // Validate plausibility — both state + code must be present and look
  // like opaque tokens, not literal placeholder strings.
  if (!params.state || !params.code || !params.provider) {
    return (
      <Page heading="Incomplete callback">
        <p>
          The provider redirected without one of the required parameters
          (state, code, provider). Run <code>semantos legacy connect &lt;provider&gt;</code>{" "}
          again. If this keeps happening, your client config may be wrong.
        </p>
      </Page>
    );
  }

  return (
    <Page heading={`Connected: ${humanProvider(params.provider)}`}>
      <p>
        Run this command in your <code>semantos</code> REPL to complete the
        grant. State nonces expire after 10 minutes — copy now.
      </p>
      <ResumeCommand state={params.state} code={params.code} />
      <p className="muted small">
        After you paste the command, the operator node verifies the state
        nonce and exchanges the code with {humanProvider(params.provider)} for
        an access + refresh token. The token is encrypted at rest under your
        wallet KEK before persisting.
      </p>
      <details>
        <summary>What if I closed the terminal?</summary>
        <p>
          The state nonce only lives in your local node&apos;s memory until you
          run <code>legacy resume</code>, so re-running{" "}
          <code>semantos legacy connect &lt;provider&gt;</code> is the
          recovery path. Each attempt issues a fresh nonce; abandoned ones
          time out automatically.
        </p>
      </details>
    </Page>
  );
}

function ResumeCommand({ state, code }: { state: string; code: string }) {
  const cmd = `legacy resume ${shellQuote(state)} ${shellQuote(code)}`;
  return (
    <CodeBlock label="paste into your semantos REPL" copyable>
      {cmd}
    </CodeBlock>
  );
}

function CodeBlock({
  label,
  children,
  copyable = false,
}: {
  label: string;
  children: string;
  copyable?: boolean;
}) {
  return (
    <figure>
      <figcaption>{label}</figcaption>
      <pre>
        <code>{children}</code>
      </pre>
      {copyable ? <CopyButton value={children} /> : null}
    </figure>
  );
}

function Page({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "2rem 1rem",
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.5,
        color: "#222",
      }}
    >
      <h1 style={{ fontSize: "1.5rem", marginTop: 0 }}>{heading}</h1>
      {children}
      <hr style={{ marginTop: "3rem", border: 0, borderTop: "1px solid #eee" }} />
      <p className="muted small">
        Temporary OAuth-callback handler — moves to the operator&apos;s wallet
        origin once WSITE3 ships.
      </p>
      <style>{`
        code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        pre { background: #f4f4f4; padding: 0.75rem 1rem; border-radius: 4px;
              overflow-x: auto; word-break: break-all; white-space: pre-wrap; }
        figcaption { font-size: 0.75rem; text-transform: uppercase;
                     letter-spacing: 0.05em; color: #666; margin-bottom: 0.25rem; }
        figure { margin: 1rem 0; }
        details { margin-top: 1.5rem; }
        details summary { cursor: pointer; color: #555; }
        .muted { color: #666; }
        .small { font-size: 0.875rem; }
      `}</style>
    </main>
  );
}

function humanProvider(id: string): string {
  switch (id) {
    case "gmail": return "Gmail";
    case "meta-pages": return "Meta Pages";
    case "whatsapp-cloud": return "WhatsApp Cloud";
    case "g-cal": return "Google Calendar";
    case "xero": return "Xero";
    default: return id;
  }
}

/** Shell-safe single-quoting for embedded `'` characters in the displayed command. */
function shellQuote(raw: string): string {
  if (/^[A-Za-z0-9_\-./:=]+$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, "'\\''")}'`;
}
