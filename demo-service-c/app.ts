import { formatUnits, isAddress, maxUint256, toHex, type Address, type Hex } from "viem";
import { decodePolicy, Decision, TOKEN_PURCHASE_SELECTOR } from "../sdk/policy.js";
import { parseUsdc } from "./policy.js";

type Config = { audience: string; chainId: number; token: Address; deploymentBytecode: Hex };
type Snapshot = { agentId: Address; owner: Address; revoked: boolean; target: Address; amount: string; decision: string;
  blockNumber: string; policy: Hex; policyHash: Hex; policyRevision: string };
type Pending = { hash: Hex; kind: "deploy" | "policy"; chainId: number; agentId: Address; target: Address; expectedPolicyHash?: Hex };
type Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
export function mountServiceC(): () => void {
const lifecycle = new AbortController();
let disposed = false;
const listen = (element: HTMLElement, type: string, listener: (event: Event) => void) => element.addEventListener(type, listener, { signal: lifecycle.signal });
const provider = () => (window as unknown as { ethereum?: Provider }).ethereum;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id).value.trim();
let config: Config;
let busy = false;
let pending: Pending | undefined;
const labels: Record<string, string> = { ALLOW: "Allowed by policy", REQUIRE_OWNER_SIGNATURE: "Owner signature required", DENY: "Denied by policy" };
const storage = {
  get(key: string) { try { return localStorage.getItem(`agentic-service-c:${key}`); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(`agentic-service-c:${key}`, value); } catch { /* Private browsing can disable persistence. */ } },
};

function status(message: string, error = false) {
  if (disposed) return;
  el("status").textContent = message;
  el("status").parentElement!.classList.toggle("error", error);
}
function controls() {
  if (disposed) return;
  for (const node of document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button"))
    node.disabled = busy || !config;
  el<HTMLButtonElement>("deploy").disabled ||= Boolean(pending);
  el<HTMLButtonElement>("check-tx").hidden = !pending;
  el<HTMLButtonElement>("copy").disabled ||= !isAddress(input("target"));
  el<HTMLButtonElement>("copy-policy").disabled ||= !isAddress(input("target"));
  const link = el<HTMLAnchorElement>("tx-link");
  link.hidden = !pending || pending.chainId !== 11155111;
  if (pending) link.href = `https://sepolia.etherscan.io/tx/${pending.hash}`;
}
async function work(action: () => Promise<void>) {
  if (busy || disposed) return;
  busy = true; controls();
  try { await action(); }
  catch (error) { status(error instanceof Error ? error.message : "Operation failed. Check your wallet before retrying.", true); }
  finally { busy = false; controls(); }
}
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...(data ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {}), signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(30_000)]) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Service returned ${response.status}`);
  return body as T;
}
function addresses() {
  const agentId = input("agent"), target = input("target");
  if (!isAddress(agentId) || !isAddress(target)) throw new Error("Enter your agent ID and deploy or enter a Service C target first.");
  storage.set(`${config.chainId}:agent`, agentId); storage.set(`${config.chainId}:target`, target);
  return { agentId, target };
}
function updatePrompt() {
  const target = input("target"), agentId = input("agent");
  el("copy").textContent = `Copy ${input("amount")}-USDC purchase prompt`;
  if (!isAddress(target)) { el("agent-prompt").textContent = "Choose a service target in one-time setup first."; return; }
  const amount = input("amount"); parseUsdc(amount);
  const url = `${location.origin}/private/quote?${new URLSearchParams({ target, amount })}`;
  el("agent-prompt").textContent = `Check a ${amount}-USDC compute-credit purchase from Service C. This is a read-only demo: purchase checked, not paid. ${isAddress(agentId) ? `Use agent ${agentId}.` : "Use my Agentic World identity; if I have several, ask which one."} GET ${url}${location.protocol === "http:" ? " (intentional loopback HTTP)" : ""}. Expected audience: ${config.audience}. Only if the resource offers AgenticWorld in its 401, retry with Agent-ID, sign the service-issued challenge using agentic_session_proof, and retry the same resource with the returned proof headers. The service must recognize my registered owner wallet. Verify the quote uses chain ${config.chainId}, target ${target}, USDC ${config.token}, amount ${amount}, and zero native value. Use agentic_policy_check for the quoted purchaseCompute call to independently read my account's current decision; report that decision, agent ID, revision/block when available, and any difference from the service quote. ALLOW is not a payment receipt. Do not request a spending signature, send tokens, grant allowances or change policy. Policy changes belong in my Agentic World portal.`;
}
async function inspect(amount = input("amount")): Promise<Snapshot> {
  parseUsdc(amount);
  const { agentId, target } = addresses();
  return api<Snapshot>(`/policy/preview?${new URLSearchParams({ agentId, target, amount })}`);
}
function render(value: Snapshot) {
  if (disposed) return;
  el("owner").textContent = value.owner;
  el("revision").textContent = value.policyRevision;
  el("auth-state").textContent = value.revoked ? "Revoked — cannot execute" : "Active";
  el("policy").textContent = value.policy === "0x" ? "No rules configured. Every action is denied." : value.policy;
  let summary = "Custom account policy. Check the requested amount to see the matching decision.";
  try {
    const rules = value.policy === "0x" ? [] : decodePolicy(value.policy);
    const [allow, approval] = rules;
    if (!rules.length) summary = "No policy configured in this agent. All actions are denied.";
    else if (rules.length === 2 && allow.decision === Decision.ALLOW && approval.decision === Decision.REQUIRE_OWNER_SIGNATURE &&
      approval.maxAmount >= allow.maxAmount && rules.every(rule => rule.target.toLowerCase() === value.target.toLowerCase() &&
      rule.token.toLowerCase() === config.token.toLowerCase() && rule.selector === TOKEN_PURCHASE_SELECTOR && rule.maxValue === 0n))
      summary = `Stored in the agent account: up to ${formatUnits(allow.maxAmount, 6)} USDC per purchase is allowed. Above that${approval.maxAmount === maxUint256 ? "" : `, up to ${formatUnits(approval.maxAmount, 6)} USDC,`} needs the owner’s signature. Other actions and amounts are denied.`;
  } catch { summary = "Policy could not be summarized. The decision below is read directly from the account."; }
  el("policy-summary").textContent = summary;
  el("decision").dataset.state = value.decision;
  el("decision-label").textContent = labels[value.decision] ?? "Unknown decision";
  el("decision-detail").textContent = `${value.amount} USDC · ${value.decision === "ALLOW" ? "Within an allowed rule." : value.decision === "DENY" ? "No matching allow rule. Owner approval cannot bypass DENY." : "Execution needs the owner’s signature bound to this exact action and current policy."}${value.revoked ? " Authenticator is revoked; policy ALLOW does not restore it." : ""}`;
  el("decision-block").textContent = `Block ${value.blockNumber} · policy revision ${value.policyRevision} · Purchase checked—not paid`;
  void refreshHistory().catch(() => {});
  updatePrompt();
}
async function refreshHistory() {
  const result = await api<{ events: (Snapshot & { source: string })[] }>("/activity");
  if (disposed) return;
  const events = result.events.filter(item => item.agentId.toLowerCase() === input("agent").toLowerCase() &&
    item.target.toLowerCase() === input("target").toLowerCase()).slice(0, 12);
  if (!events.length) { el("history").textContent = "Checks for the selected agent and target will appear here, including requests from your agent."; return; }
  el("history").replaceChildren(...events.map(item => {
    const row = document.createElement("div"); row.className = "history-row";
    const title = document.createElement("strong"); title.textContent = `${item.amount} USDC → ${labels[item.decision]}`;
    const detail = document.createElement("span"); detail.textContent = `${item.source === "agent" ? "Authenticated agent" : "Browser preview"} · revision ${item.policyRevision} · block ${item.blockNumber}`;
    row.append(title, detail); return row;
  }));
}
async function wallet(): Promise<{ ethereum: Provider; from: Address }> {
  const ethereum = provider();
  if (!ethereum) throw new Error("Open this page in a browser with MetaMask or another injected wallet.");
  const accounts = await ethereum.request({ method: "eth_requestAccounts" }) as Address[];
  if (!accounts[0]) throw new Error("Select a wallet account first.");
  const chainId = toHex(config.chainId);
  if (BigInt(await ethereum.request({ method: "eth_chainId" }) as string) !== BigInt(config.chainId))
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  if (BigInt(await ethereum.request({ method: "eth_chainId" }) as string) !== BigInt(config.chainId)) throw new Error("Wallet is on the wrong chain.");
  // Refresh after switching: the selected account may also have changed.
  const selected = await ethereum.request({ method: "eth_accounts" }) as Address[];
  if (!selected[0]) throw new Error("Wallet disconnected.");
  el("connected-wallet").textContent = `Connected · ${selected[0]}`;
  return { ethereum, from: selected[0] };
}
function rememberPending(value: Pending | undefined) {
  pending = value;
  storage.set(`${config.chainId}:pending`, value ? JSON.stringify(value) : "");
  controls();
}
async function checkTransaction() {
  if (!pending) return;
  const value = pending;
  const receipt = await api<{ status: string; contractAddress?: Address }>(`/transaction?hash=${value.hash}`);
  if (receipt.status === "pending") { status(`Transaction ${value.hash} is still pending. Check again; do not resubmit.`); return; }
  if (receipt.status !== "success") { rememberPending(undefined); throw new Error(`Transaction reverted: ${value.hash}. No policy or deployment change was applied.`); }
  if (value.kind === "deploy") {
    if (!receipt.contractAddress) throw new Error("Confirmed receipt did not include a deployment address. Check the transaction before retrying.");
    el<HTMLInputElement>("target").value = receipt.contractAddress;
    storage.set(`${config.chainId}:target`, receipt.contractAddress);
    rememberPending(undefined);
    el<HTMLDetailsElement>("service-setup").open = false;
    updateTarget(); updatePrompt();
    status("Service target ready. Copy the prompt, or enter an agent address to read its policy. No tokens were moved.");
  } else {
    el<HTMLInputElement>("agent").value = value.agentId;
    el<HTMLInputElement>("target").value = value.target;
    const snapshot = await inspect(); render(snapshot);
    rememberPending(undefined);
    status(snapshot.policyHash.toLowerCase() === value.expectedPolicyHash?.toLowerCase()
      ? "Policy confirmed onchain. Try the 1 and 2 USDC packs to check the saved rules."
      : "Transaction confirmed, but the current policy differs from the submitted one. Review its current revision before making another change.");
  }
}
async function submitted(value: Pending) {
  rememberPending(value);
  status(`Submitted ${value.hash}. Waiting for confirmation; closing this page cannot cancel the transaction.`);
  // A bounded check; retain the hash across reloads and never send twice automatically.
  for (let i = 0; i < 20 && pending && !disposed; i++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (!disposed) await checkTransaction();
  }
}

listen(el("connect-wallet"), "click", () => void work(async () => {
  const { ethereum, from } = await wallet();
  const current = await api<{ registered: boolean }>(`/owner/status?owner=${from}`);
  if (!current.registered) {
    status("Sign the registration message in your wallet. This grants quote access only, not spending authority.");
    const challenge = await api<{ nonce: Hex; message: string }>("/owner/challenge", { owner: from });
    const signature = await ethereum.request({ method: "personal_sign", params: [toHex(challenge.message), from] });
    await api("/owner/register", { owner: from, nonce: challenge.nonce, signature });
  }
  el("connected-wallet").textContent = `Registered · ${from}. Agents owned by this wallet can request quotes.`;
  status("Owner registered. No agent allowlist, payment approval or account-policy change was made.");
}));
listen(el("deploy"), "click", () => void work(async () => {
  if (pending) throw new Error("Check the previously submitted transaction first.");
  if (!window.confirm("Deploy one Service C demo target on Sepolia? This costs testnet gas. Reuse an existing target address if you already deployed one.")) return;
  const { ethereum, from } = await wallet();
  status("Approve the demo target deployment in your wallet. No agent deployment or token approval is included.");
  const hash = await ethereum.request({ method: "eth_sendTransaction", params: [{ from, data: config.deploymentBytecode, value: "0x0", chainId: toHex(config.chainId) }] }) as Hex;
  await submitted({ hash, chainId: config.chainId, kind: "deploy", agentId: from, target: from });
}));
const preview = () => work(async () => { status("Reading the latest onchain policy…"); render(await inspect()); status("Policy read from chain. No transaction submitted."); });
listen(el("inspect"), "click", () => void preview());
listen(el("preview-form"), "submit", event => { event.preventDefault(); void preview(); });
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-amount]")) listen(button, "click", () => {
  el<HTMLInputElement>("amount").value = button.dataset.amount!;
  for (const pack of document.querySelectorAll<HTMLButtonElement>("[data-amount]")) pack.setAttribute("aria-pressed", String(pack === button));
  invalidate(); updatePrompt();
  status(`${input("amount")} USDC selected. Copy the purchase-check prompt or read the account policy.`);
});
listen(el("check-tx"), "click", () => void work(checkTransaction));
listen(el("copy"), "click", () => void work(async () => {
  updatePrompt(); await navigator.clipboard.writeText(el("agent-prompt").textContent!); status("Agent instruction copied. It requests a quote, not a payment.");
}));
listen(el("copy-policy"), "click", () => void work(async () => {
  const target = input("target"); if (!isAddress(target)) throw new Error("Set a Service C target first.");
  const agent = input("agent");
  const prompt = `Open agentic_portal for ${isAddress(agent) ? `my agent ${agent}` : "my Agentic World agent (ask which identity if there are several)"} on chain ${config.chainId}. Help me configure ordered Token purchase rules for Service C's compute-credit purchase. Target: ${target}. Function: purchaseCompute(address,uint256), selector ${TOKEN_PURCHASE_SELECTOR}. Token: USDC ${config.token}, 6 decimals. Native value: 0. First rule: ALLOW up to 1 USDC (1000000 base units). Second: REQUIRE_OWNER_SIGNATURE up to 2 USDC (2000000 base units). Unmatched actions remain DENY. Explain existing rules before I replace anything; I must save and approve the policy in my wallet. Then I can compare Service C's 1 and 2 USDC packs. Do not send tokens, grant allowances, or edit policy outside the portal.`;
  await navigator.clipboard.writeText(prompt); status("Portal instructions copied. Configure and save the policy there; Service C only reads it.");
}));
function updateTarget() {
  const target = input("target");
  el("target-state").textContent = isAddress(target) ? `${target.slice(0, 8)}…${target.slice(-4)}` : "Not configured";
  if (config && isAddress(target)) storage.set(`${config.chainId}:target`, target);
}
function invalidate() {
  el("decision").dataset.state = "idle"; el("decision-label").textContent = "Check again";
  el("decision-detail").textContent = "Inputs changed. Read the contract for a fresh result."; el("decision-block").textContent = "";
  el("policy-summary").textContent = "Read the contract to see the rules for this agent and target.";
  for (const id of ["owner", "revision", "auth-state"]) el(id).textContent = "—";
  el("policy").textContent = "Read the current account policy.";
}
for (const id of ["agent", "target", "amount"]) listen(el(id), "input", () => {
  invalidate();
  updateTarget(); controls();
  try { updatePrompt(); } catch { el("agent-prompt").textContent = "Enter a positive amount with up to six decimal places."; }
});
void work(async () => {
  config = await api<Config>("/config");
  if (disposed) return;
  el("network").textContent = config.chainId === 11155111 ? "Ethereum Sepolia · 11155111" : `Local test · ${config.chainId}`;
  el("token").textContent = `USDC · ${config.token} · 6 decimals`;
  el<HTMLInputElement>("agent").value = storage.get(`${config.chainId}:agent`) ?? "";
  el<HTMLInputElement>("target").value = storage.get(`${config.chainId}:target`) ?? "";
  updateTarget(); updatePrompt();
  el<HTMLDetailsElement>("service-setup").open = !isAddress(input("target"));
  const saved = storage.get(`${config.chainId}:pending`);
  if (saved) {
    try {
      const value = JSON.parse(saved) as Pending;
      if (value.chainId === config.chainId && /^0x[0-9a-fA-F]{64}$/.test(value.hash) && ["deploy", "policy"].includes(value.kind)) pending = value;
    } catch { /* Ignore malformed browser state. */ }
  }
  status(pending ? "A submitted transaction was restored. Check it before sending another." : "Register your owner wallet for agent access. Reading public account policy does not require registration.");
});
const timer = setInterval(() => { if (config && !document.hidden && isAddress(input("agent"))) void refreshHistory().catch(() => {}); }, 3000);

return () => { disposed = true; lifecycle.abort(); clearInterval(timer); };
}
