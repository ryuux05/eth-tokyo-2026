import { encodeFunctionData, isAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { agentPolicyAbi } from "../sdk/policy.js";
import { parseUsdc, serviceCPolicy } from "./policy.js";

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
  el<HTMLButtonElement>("save").disabled ||= Boolean(pending) || !el<HTMLInputElement>("replace").checked;
  el<HTMLButtonElement>("check-tx").hidden = !pending;
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
async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(30_000)]) });
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
  const { agentId, target } = addresses();
  const amount = input("amount"); parseUsdc(amount);
  const url = `${location.origin}/private/quote?${new URLSearchParams({ target, amount })}`;
  el("agent-prompt").textContent = `GET ${url}. This is my Service C policy workbench${location.protocol === "http:" ? " (intentional loopback HTTP)" : ""}; expected audience: ${config.audience}. If the 401 offers AgenticWorld, retry the same resource with Agent-ID ${agentId}, sign its challenge using agentic_session_proof, and retry using the returned proof headers. Report the policy decision and block. This is a read-only quote: do not submit a payment, approval, or policy transaction.`;
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
  el("decision").dataset.state = value.decision;
  el("decision-label").textContent = labels[value.decision] ?? "Unknown decision";
  el("decision-detail").textContent = `${value.amount} USDC · ${value.decision === "ALLOW" ? "Within an allowed rule." : value.decision === "DENY" ? "No matching allow rule. Owner approval cannot bypass DENY." : "Execution needs the owner’s signature bound to this exact action and current policy."}${value.revoked ? " Authenticator is revoked; policy ALLOW does not restore it." : ""}`;
  el("decision-block").textContent = `Block ${value.blockNumber} · policy revision ${value.policyRevision} · no transfer submitted`;
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
    status("Demo target deployed. Enter your agent ID, then read its current policy. No tokens were moved.");
  } else {
    el<HTMLInputElement>("agent").value = value.agentId;
    el<HTMLInputElement>("target").value = value.target;
    const snapshot = await inspect(); render(snapshot);
    rememberPending(undefined);
    el<HTMLInputElement>("replace").checked = false;
    status(snapshot.policyHash.toLowerCase() === value.expectedPolicyHash?.toLowerCase()
      ? "Policy confirmed onchain. Try 5 and 5.000001 USDC, then change the boundary and check again."
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
  await wallet(); status("Wallet connected to Sepolia. Connecting does not sign or submit a transaction.");
}));
listen(el("deploy"), "click", () => void work(async () => {
  if (pending) throw new Error("Check the previously submitted transaction first.");
  if (!window.confirm("Deploy one Service C demo target on Sepolia? This costs testnet gas. Reuse an existing target address if you already deployed one.")) return;
  const { ethereum, from } = await wallet();
  status("Approve the demo target deployment in your wallet. No agent deployment or token approval is included.");
  const hash = await ethereum.request({ method: "eth_sendTransaction", params: [{ from, data: config.deploymentBytecode, value: "0x0", chainId: toHex(config.chainId) }] }) as Hex;
  await submitted({ hash, chainId: config.chainId, kind: "deploy", agentId: from, target: from });
}));
listen(el("save"), "click", () => void work(async () => {
  if (pending || !el<HTMLInputElement>("replace").checked) throw new Error("Acknowledge the full policy replacement and resolve any pending transaction first.");
  const state = await inspect();
  const { ethereum, from } = await wallet();
  if (state.owner.toLowerCase() !== from.toLowerCase()) throw new Error(`Connect the agent's owner wallet: ${state.owner}`);
  const policy = serviceCPolicy(state.target, config.token, parseUsdc(input("threshold")));
  const data = encodeFunctionData({ abi: agentPolicyAbi, functionName: "setPolicy", args: [policy] });
  status("Confirm the policy replacement in your wallet. The existing rules remain until the transaction confirms.");
  const hash = await ethereum.request({ method: "eth_sendTransaction", params: [{ from, to: state.agentId, data, value: "0x0", chainId: toHex(config.chainId) }] }) as Hex;
  await submitted({ hash, chainId: config.chainId, kind: "policy", agentId: state.agentId, target: state.target, expectedPolicyHash: keccak256(policy) });
}));
const preview = () => work(async () => { status("Reading the latest onchain policy…"); render(await inspect()); status("Policy read from chain. No transaction submitted."); });
listen(el("inspect"), "click", () => void preview());
listen(el("preview-form"), "submit", event => { event.preventDefault(); void preview(); });
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-amount]")) listen(button, "click", () => {
  el<HTMLInputElement>("amount").value = button.dataset.amount!; void preview();
});
listen(el("replace"), "change", controls);
listen(el("check-tx"), "click", () => void work(checkTransaction));
listen(el("copy"), "click", () => void work(async () => {
  updatePrompt(); await navigator.clipboard.writeText(el("agent-prompt").textContent!); status("Agent instruction copied. It requests a quote, not a payment.");
}));
void work(async () => {
  config = await api<Config>("/config");
  if (disposed) return;
  el("network").textContent = config.chainId === 11155111 ? "Ethereum Sepolia · 11155111" : `Local test · ${config.chainId}`;
  el("token").textContent = `USDC · ${config.token} · 6 decimals`;
  el<HTMLInputElement>("agent").value = storage.get(`${config.chainId}:agent`) ?? "";
  el<HTMLInputElement>("target").value = storage.get(`${config.chainId}:target`) ?? "";
  const saved = storage.get(`${config.chainId}:pending`);
  if (saved) {
    try {
      const value = JSON.parse(saved) as Pending;
      if (value.chainId === config.chainId && /^0x[0-9a-fA-F]{64}$/.test(value.hash) && ["deploy", "policy"].includes(value.kind)) pending = value;
    } catch { /* Ignore malformed browser state. */ }
  }
  status(pending ? "A submitted transaction was restored. Check it before sending another." : "Enter your agent and deploy or reuse a demo target. Read policy before making changes.");
});
const timer = setInterval(() => { if (config && !document.hidden && isAddress(input("agent"))) void refreshHistory().catch(() => {}); }, 3000);

return () => { disposed = true; lifecycle.abort(); clearInterval(timer); };
}
