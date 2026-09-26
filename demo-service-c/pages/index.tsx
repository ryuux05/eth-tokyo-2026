import Head from "next/head";
import { useEffect } from "react";

export default function PolicyWorkbench() {
  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../app.js").then(({ mountServiceC }) => { if (!cancelled) dispose = mountServiceC(); });
    return () => { cancelled = true; dispose?.(); };
  }, []);
  return <><Head><title>Service C · Policy workbench</title><meta name="viewport" content="width=device-width,initial-scale=1" /></Head>
<header className="topbar"><strong>Agentic World <span>/ Service C</span></strong><span id="network">Connecting…</span></header>
<main>
  <header className="intro"><h1>Where autonomy stops.</h1><p>Try a purchase amount. Read the agent’s onchain policy. Change the boundary with your owner wallet and check again.</p></header>
  <p className="notice">Decision demo only. This page never transfers or approves USDC. Do not fund an agent for this preview. Testnet USDC has no real-dollar value; “$5” here means 5 USDC per operation, not a daily cap.</p>
  <div className="workbench">
    <section className="setup" aria-labelledby="setup-title">
      <h2 id="setup-title">Connect the policy</h2>
      <button id="connect-wallet" className="secondary" disabled>Connect wallet</button><p id="connected-wallet" className="hint">Not connected · signing stays in your browser wallet.</p>
      <label htmlFor="agent">Agent ID</label><input id="agent" placeholder="0x…" spellCheck="false" autoComplete="off" />
      <label htmlFor="target">Service C demo target</label><input id="target" placeholder="Deploy below, or paste an existing Service C target" spellCheck="false" autoComplete="off" />
      <div className="actions"><button id="deploy" className="secondary" disabled>Deploy demo target</button><button id="inspect" className="secondary" disabled>Read current policy</button></div>
      <p className="hint">One-time target deployment uses your wallet and Sepolia gas. It does not redeploy your agent. Reuse the address on future visits.</p>
      <dl><div><dt>Owner</dt><dd id="owner">Read an agent first</dd></div><div><dt>Policy revision</dt><dd id="revision">—</dd></div><div><dt>Authenticator</dt><dd id="auth-state">—</dd></div></dl>
      <details><summary>Current encoded policy</summary><pre id="policy">Read an agent to inspect its existing rules.</pre></details>
      <hr />
      <h2>Set the boundary</h2>
      <label htmlFor="threshold">Automatic purchase limit · USDC</label><input id="threshold" defaultValue="5" inputMode="decimal" autoComplete="off" />
      <p className="hint">At or below this amount: allow. Above it: require an exact owner signature. Every other action: deny.</p>
      <label className="check"><input type="checkbox" id="replace" />I understand this replaces this agent’s entire execution policy, including any existing rules.</label>
      <button id="save" disabled>Save policy in wallet</button>
      <p className="hint">Only the agent’s onchain owner can save. No key or token allowance is requested.</p>
    </section>
    <section className="decision-panel" aria-labelledby="decision-title">
      <h2 id="decision-title">Test a purchase</h2>
      <p>Calls <code>evaluateAction()</code> for <code>purchaseCompute(USDC, amount)</code> on your agent.</p>
      <form id="preview-form"><label htmlFor="amount">Purchase amount · USDC</label><div className="amount-row"><input id="amount" defaultValue="5" inputMode="decimal" autoComplete="off" /><button id="preview" disabled>Check policy</button></div></form>
      <div className="presets" aria-label="Boundary test amounts"><button className="secondary" data-amount="2">2</button><button className="secondary" data-amount="5">5 exactly</button><button className="secondary" data-amount="5.000001">5 + 1 unit</button><button className="secondary" data-amount="20">20</button></div>
      <div className="decision" id="decision" data-state="idle" aria-live="polite"><strong id="decision-label">No decision yet</strong><p id="decision-detail">Read an agent and its demo target, then check an amount.</p><small id="decision-block"></small></div>
      <p className="hint">A policy result is not a payment receipt. Balance, allowance, gas, revocation, and owner approval can still prevent execution.</p>
      <hr /><h2>Let your agent check</h2><p>The same resource endpoint offers Agentic World authentication through the SDK. Authentication grants access to a quote, not permission to spend.</p>
      <pre id="agent-prompt">Read an agent and target to generate the instruction.</pre><button id="copy" className="secondary" disabled>Copy agent instruction</button>
    </section>
  </div>
  <section className="status-region" aria-label="Operation status"><p id="status" role="status">Loading Sepolia configuration…</p><a id="tx-link" hidden target="_blank" rel="noopener noreferrer">View submitted transaction</a><button id="check-tx" className="secondary" hidden>Check submitted transaction</button></section>
  <section className="history"><h2>Observed decisions</h2><p>Fresh reads, with their policy revision and block. Changing the limit only takes effect after the wallet transaction confirms.</p><div id="history" aria-live="polite">Your checks will appear here.</div></section>
  <footer><p>For execution proof, run <code>npm run test:service-c</code>. The local test uses a real EntryPoint and a software P-256 fixture, not your hardware key.</p><p>Existing Sepolia pins remain unchanged. This preview does not certify the old account deployment as safe for funded execution.</p><code id="token"></code></footer>
</main>
</>;
}
