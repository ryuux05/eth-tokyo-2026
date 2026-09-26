type WalletProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
type Event = { at: string; kind: string; detail: string; owner?: string; agentId?: string };
type Lookup = { agentId: string; owner: string; ownerRegistered: boolean; report: boolean };

declare global { interface Window { ethereum?: WalletProvider } }

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let wallet: string | undefined;
let inspectedAgent: string | undefined;
let lastAllowedEvent: string | undefined;

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  let body: any;
  try { body = await response.json(); } catch { body = { error: "Invalid service response" }; }
  return { status: response.status, body };
}

function setStatus(id: string, message: string, error = false): void {
  const element = byId(id);
  element.textContent = message;
  element.classList.toggle("error", error);
}

function setResult(id: string, code: number, title: string, detail: string): void {
  const element = byId(id);
  element.className = `result ${code === 200 ? "allowed" : code === 401 || code === 403 ? "denied" : "error"}`;
  element.replaceChildren();
  const status = document.createElement("span"); status.className = "result-code"; status.textContent = String(code);
  const content = document.createElement("div");
  const heading = document.createElement("strong"); heading.textContent = title;
  const body = document.createElement("p"); body.textContent = detail;
  content.append(heading, body); element.append(status, content);
}

async function refreshWallet(): Promise<void> {
  if (!wallet) return;
  const { status, body } = await request(`/owner/status?address=${encodeURIComponent(wallet)}`);
  if (status !== 200) throw new Error(body.error ?? "Could not check wallet registration");
  byId("entitlement-value").textContent = body.registered ? body.report ? "Registered · report active" : "Registered · report denied" : "Not registered";
  if (body.registered) setStatus("wallet-state", "Your wallet is registered. An agent owned by it can now authenticate independently.");
}

byId<HTMLButtonElement>("register-wallet").addEventListener("click", async () => {
  const button = byId<HTMLButtonElement>("register-wallet");
  if (!window.ethereum) { setStatus("wallet-state", "No browser wallet found. Open this page in a browser with MetaMask or another injected wallet.", true); return; }
  button.disabled = true;
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
    const owner = accounts[0];
    if (!owner) throw new Error("Select a wallet account first");
    wallet = owner;
    byId("wallet-address").textContent = owner;
    const current = await request(`/owner/status?address=${encodeURIComponent(owner)}`);
    if (current.status !== 200) throw new Error(current.body.error ?? "Could not check wallet");
    if (!current.body.registered) {
      setStatus("wallet-state", "Approve the one-time registration message in your wallet. No transaction or gas is required.");
      const challenge = await request("/owner/challenge", { method: "POST", body: JSON.stringify({ owner }) });
      if (challenge.status !== 200) throw new Error(challenge.body.error ?? "Could not request wallet challenge");
      const signature = await window.ethereum.request({ method: "personal_sign", params: [challenge.body.message, owner] }) as string;
      const registration = await request("/owner/register", { method: "POST", body: JSON.stringify({ owner, nonce: challenge.body.nonce, signature }) });
      if (registration.status !== 200) throw new Error(registration.body.error ?? "Registration was rejected");
    }
    await refreshWallet();
    await refreshEvents();
    if (inspectedAgent) await inspectAgent(inspectedAgent);
  } catch (error) { setStatus("wallet-state", error instanceof Error ? error.message : "Wallet registration failed", true); }
  finally { button.disabled = false; }
});

async function inspectAgent(agentId: string): Promise<void> {
  const { status, body } = await request("/agent/lookup", { method: "POST", body: JSON.stringify({ agentId }) });
  if (status !== 200) throw new Error(body.error ?? "Could not inspect agent");
  const result = body as Lookup;
  inspectedAgent = result.agentId;
  byId("agent-details").hidden = false;
  byId("agent-owner").textContent = result.owner;
  const matches = Boolean(wallet && result.owner.toLowerCase() === wallet.toLowerCase());
  byId("agent-access").textContent = result.ownerRegistered && result.report ? "Owner registered · report available after agent proof" : "Owner not registered for report";
  setStatus("agent-state", matches ? "This agent belongs to your connected wallet. Ask Codex to authenticate to Service B." :
    "This agent's owner does not match the wallet connected in this tab. Service B uses the onchain owner, not this page's input.", !matches);
}

byId<HTMLFormElement>("inspect-form").addEventListener("submit", async event => {
  event.preventDefault();
  try { await inspectAgent(byId<HTMLInputElement>("agent-id").value.trim()); }
  catch (error) { byId("agent-details").hidden = true; setStatus("agent-state", error instanceof Error ? error.message : "Could not inspect agent", true); }
});

byId<HTMLButtonElement>("before-button").addEventListener("click", async () => {
  try {
    const { status, body } = await request("/private/report");
    setResult("before-result", status, status === 401 ? "Denied before agent authentication" : "Unexpected response", body.error ?? JSON.stringify(body));
    await refreshEvents();
  } catch (error) { setStatus("copy-state", error instanceof Error ? error.message : "Could not reach Service B", true); }
});

byId<HTMLButtonElement>("copy-agent-prompt").addEventListener("click", async () => {
  const prompt = `Use my Agentic World identity to access Service B at ${location.origin}. Authenticate with its /agent/challenge and /agent/session endpoints, then GET /private/report with the Agent-Session header. Report the HTTP status and response. Do not use my human wallet credentials.`;
  try { await navigator.clipboard.writeText(prompt); setStatus("copy-state", "Instruction copied. Paste it into a Codex session with the Agentic World MCP."); }
  catch { setStatus("copy-state", `Clipboard unavailable. Give Codex this URL: ${location.origin}`, true); }
});

async function refreshEvents(): Promise<void> {
  const { status, body } = await request("/activity");
  if (status !== 200) throw new Error(body.error ?? "Could not read activity");
  const events = body.events as Event[];
  const container = byId("events"); container.replaceChildren();
  if (!events.length) { const p = document.createElement("p"); p.textContent = "No service decisions yet."; container.append(p); }
  for (const event of events) {
    const row = document.createElement("div"); row.className = "event"; row.dataset.kind = event.kind;
    const time = document.createElement("time"); time.dateTime = event.at; time.textContent = new Date(event.at).toLocaleTimeString();
    const kind = document.createElement("span"); kind.className = "event-kind"; kind.textContent = event.kind;
    const detail = document.createElement("span"); detail.className = "event-details"; detail.textContent = `${event.detail}${event.agentId ? ` · ${event.agentId.slice(0, 10)}…` : ""}`;
    row.append(time, kind, detail); container.append(row);
  }
  const allowed = events.find(event => event.kind === "ALLOWED" && (!wallet || event.owner?.toLowerCase() === wallet.toLowerCase()));
  if (allowed && allowed.at !== lastAllowedEvent) {
    lastAllowedEvent = allowed.at;
    setResult("after-result", 200, "Agent access confirmed", `${allowed.agentId} accessed the report at ${new Date(allowed.at).toLocaleTimeString()}.`);
  }
}

byId<HTMLButtonElement>("refresh-button").addEventListener("click", () => { void refreshEvents().catch(error => setStatus("copy-state", error.message, true)); });
void request("/health").then(({ body }) => { byId("chain-label").textContent = `CHAIN ${body.chainId} · 127.0.0.1`; }).catch(() => { byId("chain-label").textContent = "SERVICE OFFLINE"; });
void refreshEvents().catch(() => {});
setInterval(() => { void refreshEvents().catch(() => {}); }, 3000);
