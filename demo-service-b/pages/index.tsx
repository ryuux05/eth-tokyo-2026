import Head from "next/head";
import { useEffect } from "react";

export default function ServiceBPage() {
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../app.js").then(({ mountServiceB }) => { if (!cancelled) dispose = mountServiceB(); });
    return () => { cancelled = true; dispose?.(); };
  }, []);
  return <><Head><title>Service B · Agent permissions</title><meta name="viewport" content="width=device-width,initial-scale=1" /></Head>

  <header className="topbar">
    <div className="brand"><span className="brand-mark" aria-hidden="true">A<span>·</span>W</span><span>Agentic World <span className="slash">/</span> Service B</span></div>
    <span id="chain-label" className="top-note">CONNECTING</span>
  </header>
  <main className="shell permission-shell">
    <header className="intro">
      <h1>Your text.<br />Your agent’s permissions.</h1>
      <p className="lede">Read lets your agent see the text. Write lets it change the text. You decide with two checkboxes.</p>
      <p><a className="report-link" href="/private/report">Get my private report</a></p>
    </header>
    <section aria-labelledby="owner-title" className="owner-signin">
      <h2 id="owner-title">Sign in as the owner</h2>
      <div className="wallet-actions"><button id="register-wallet" className="button primary" type="button">Sign in with wallet</button><code id="wallet-address">Not signed in</code></div>
      <p className="inline-state">One message signature opens a one-hour session. Checkbox changes need no transaction or additional signature.</p>
    </section>
    <section aria-labelledby="text-title" className="text-section">
      <h2 id="text-title">Private text</h2>
      <div className="private-text-row"><input id="private-text" type="password" defaultValue="************" readOnly autoComplete="off" aria-label="Private report text" /><button id="reveal" className="button secondary" type="button" disabled>Show text</button></div>
      <p id="updated" className="inline-state">Sign in to inspect your private text.</p>
      <p className="inline-state">Hidden on the page by default. Only your signed-in owner session or an agent with Read can retrieve it.</p>
    </section>
    <section aria-labelledby="permissions-title" className="permissions-section">
      <div className="activity-heading"><h2 id="permissions-title">Agent permissions</h2><button id="refresh-button" type="button" className="text-button">Refresh</button></div>
      <p className="inline-state">Your agents appear after authenticating. Read starts on; Write starts off. Changes apply to the next request, including an existing session.</p>
      <div id="agents">Sign in, then ask your agent to get the report. It will appear here after authenticating.</div>
    </section>
    <p id="status" className="inline-state" role="status">Sign in to manage your agents.</p>
    <section className="agent-instructions" aria-labelledby="try-title">
      <h2 id="try-title">Ask your agent</h2>
      <p id="visit-instruction">“Go to this website and get my report.”</p>
      <p id="write-instruction">“Go to this website and update my report to ‘Hello from my agent’.”</p>
      <p className="inline-state">The Agentic World skill and MCP handle sign-in. No protocol prompt or agent ID entry is required.</p>
      <details><summary>Resource API</summary><p>Read: <code>GET /private/report</code>. Update: <code>PUT /private/report</code> with <code>Content-Type: application/json</code> and <code>{'{"text":"your new text"}'}</code> (1–2000 characters). Both use the same Agentic World authentication offer. Read and Write are independent. A write response confirms the update without returning the text.</p></details>
    </section>
    <details className="activity"><summary>Recent activity</summary><div id="events"></div></details>
    <footer><span>AGENTIC WORLD / SERVICE B</span><span>These are service permissions, not the account’s onchain execution policy.</span></footer>
  </main>

</>;
}
