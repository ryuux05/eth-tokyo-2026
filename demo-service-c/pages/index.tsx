import Head from "next/head";
import { useEffect } from "react";

export default function PolicyWorkbench() {
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../app.js").then(({ mountServiceC }) => { if (!cancelled) dispose = mountServiceC(); });
    return () => { cancelled = true; dispose?.(); };
  }, []);
  return <><Head><title>Service C · Compute credits</title><meta name="viewport" content="width=device-width,initial-scale=1" /></Head>
<header className="topbar"><strong>Agentic World <span>/ Service C</span></strong><span id="network">Connecting…</span></header>
<main>
  <header className="intro"><h1>Compute for your agent.</h1><p>Choose a pack. Ask your agent whether its account policy allows the purchase.</p><p className="demo-label">Sepolia demo · Purchase checked—not paid.</p></header>
  <section className="owner-access" aria-label="Owner-based service access">
    <div><h2>Register your wallet, not each agent.</h2><p id="connected-wallet">Your agents get quote access through their onchain owner(). Registration does not grant spending permission.</p></div>
    <button id="connect-wallet" className="secondary" disabled>Register owner wallet</button>
  </section>
  <section className="try-payment" aria-labelledby="try-title">
    <h2 id="try-title">Choose a compute pack</h2>
    <div className="packs" role="group" aria-label="Compute packs">
      <button className="pack" data-amount="1" aria-pressed="true"><span>Small compute pack</span><strong>1 <small>USDC</small></strong><span>Check a smaller purchase</span></button>
      <button className="pack" data-amount="2" aria-pressed="false"><span>Large compute pack</span><strong>2 <small>USDC</small></strong><span>Check a larger purchase</span></button>
    </div>
    <form id="preview-form">
      <input id="amount" type="hidden" defaultValue="1" />
      <div className="actions"><button type="button" id="copy" disabled>Copy 1-USDC purchase prompt</button><button type="submit" id="preview" className="secondary" disabled>Check account policy</button></div>
      <p id="prompt-help" className="hint">Use the contract setup below once, then copy the prompt into your agent session. No tokens or compute credits are delivered.</p>
      <details className="prompt-details"><summary>See the prompt</summary><pre id="agent-prompt">Choose a service target to prepare the prompt. Your agent can select its own identity.</pre></details>
    </form>
  </section>
  <section className="account-policy" aria-labelledby="account-title">
    <div className="section-heading"><h2 id="account-title">Check the purchase</h2><span className="hint">Read from the agent account</span></div>
    <label htmlFor="agent">Agent address to inspect</label>
    <div className="amount-row"><input id="agent" placeholder="0x… (your agent can give you this)" spellCheck="false" autoComplete="off" /><button id="inspect" className="secondary" disabled>Read contract</button></div>
    <p id="policy-summary" className="policy-summary">Read an agent to see its stored rules. The account policy determines the limit, not the selected pack.</p>
    <div className="decision" id="decision" data-state="idle" aria-live="polite"><strong id="decision-label">Not checked yet</strong><p id="decision-detail">Enter an agent address and service target, then read the contract.</p><small id="decision-block"></small></div>
    <p className="hint">Change spending rules in your Agentic World portal, then read this contract again. Registering with Service C does not change those rules.</p>
    <button id="copy-policy" className="secondary" disabled>Copy portal setup instructions</button>
    <details className="technical-details"><summary>Contract details</summary>
      <dl><div><dt>Owner</dt><dd id="owner">—</dd></div><div><dt>Policy revision</dt><dd id="revision">—</dd></div><div><dt>Authenticator</dt><dd id="auth-state">—</dd></div></dl>
      <pre id="policy">No contract read yet.</pre><code id="token"></code>
    </details>
  </section>
  <details className="setup-details" id="service-setup">
    <summary>Service contract setup <span id="target-state">Not configured</span></summary>
    <p className="hint">One-time demo setup: reuse a Service C purchase contract or deploy one with your wallet. This is not a new agent account. Deployment costs Sepolia gas but moves no USDC.</p>
    <label htmlFor="target">Service C purchase contract</label><input id="target" placeholder="0x…" spellCheck="false" autoComplete="off" />
    <button id="deploy" className="secondary" disabled>Deploy purchase contract</button>
    <p className="hint">The portal’s “Token purchase” rule targets this contract’s purchaseCompute(USDC, amount) function.</p>
  </details>
  <section className="status-region" aria-label="Operation status"><p id="status" role="status">Connecting to Sepolia…</p><a id="tx-link" hidden target="_blank" rel="noopener noreferrer">View submitted transaction</a><button id="check-tx" className="secondary" hidden>Check submitted transaction</button></section>
  <details className="history"><summary>Recent policy checks</summary><div id="history" aria-live="polite">No checks yet.</div></details>
  <footer>Onchain policy preview—not a transfer or an execution guarantee. No token funding or allowance is needed. Testnet USDC amounts are not a live USD price.</footer>
</main>
</>;
}
