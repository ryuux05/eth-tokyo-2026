import { stringToHex } from "viem";

type WalletProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
type Permissions = { agentId: string; read: boolean; write: boolean };
type Workspace = { owner: string; agents: Permissions[]; report: { text: string; updatedAt: string; updatedBy?: string } };
declare global { interface Window { ethereum?: WalletProvider } }

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let workspace: Workspace | undefined;
let saving = false, refreshing = false;
let refreshQueued = false;
let refreshVersion = 0;
let agentRenderKey = "";

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(60_000) });
  const body = await response.json().catch(() => ({ error: "Invalid service response" }));
  if (!response.ok) throw new Error(body.error ?? `Service returned ${response.status}`);
  return body;
}
function status(message: string, error = false) {
  byId("status").textContent = message;
  byId("status").classList.toggle("error", error);
}
function signedOut() {
  workspace = undefined; agentRenderKey = "";
  byId("wallet-address").textContent = "Not signed in";
  byId<HTMLInputElement>("private-text").value = "************";
  byId<HTMLInputElement>("private-text").type = "password";
  byId<HTMLButtonElement>("reveal").disabled = true;
  byId("reveal").textContent = "Show text";
  byId("updated").textContent = "Sign in to inspect your private text.";
  byId("agents").textContent = "Sign in, then ask your agent to get the report. It will appear here after authenticating.";
  byId("events").replaceChildren();
}
function renderAgents(agents: Permissions[]) {
  const key = JSON.stringify(agents);
  if (key === agentRenderKey) return;
  agentRenderKey = key;
  const container = byId("agents");
  container.replaceChildren();
  if (!agents.length) {
    container.textContent = "Ask your agent to get the report. Its identity will appear here automatically.";
    return;
  }
  for (const agent of agents) {
    const row = document.createElement("div"); row.className = "permission-row";
    const identity = document.createElement("code"); identity.textContent = agent.agentId;
    const toggles = document.createElement("div"); toggles.className = "permission-toggles";
    const read = document.createElement("input"), write = document.createElement("input");
    for (const [action, checkbox] of [["read", read], ["write", write]] as const) {
      checkbox.type = "checkbox"; checkbox.checked = agent[action];
      checkbox.setAttribute("aria-label", `${action === "read" ? "Read" : "Write"} permission for ${agent.agentId}`);
      const label = document.createElement("label");
      label.append(checkbox, document.createTextNode(action === "read" ? "Read" : "Write")); toggles.append(label);
      checkbox.addEventListener("change", async () => {
        saving = true; refreshVersion++;
        for (const input of container.querySelectorAll<HTMLInputElement>("input")) input.disabled = true;
        status("Saving permissions…");
        try {
          await request("/owner/permissions", { method: "POST", body: JSON.stringify({ agentId: agent.agentId, read: read.checked, write: write.checked }) });
          status("Saved. The agent’s next request uses these permissions.");
        } catch (error) {
          read.checked = agent.read; write.checked = agent.write;
          status(error instanceof Error ? error.message : "Could not save permissions", true);
        } finally {
          saving = false; agentRenderKey = "";
          for (const input of container.querySelectorAll<HTMLInputElement>("input")) input.disabled = false;
          await refreshWorkspace();
        }
      });
    }
    row.append(identity, toggles); container.append(row);
  }
}
async function refreshWorkspace() {
  if (saving) return;
  if (refreshing) { refreshQueued = true; return; }
  refreshing = true;
  const version = refreshVersion;
  try {
    const response = await fetch("/owner/workspace", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(60_000) });
    if (version !== refreshVersion) return;
    if (response.status === 401) { signedOut(); return; }
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load your workspace");
    if (saving || version !== refreshVersion) return;
    workspace = body as Workspace;
    byId("wallet-address").textContent = `Signed in · ${workspace.owner}`;
    byId<HTMLInputElement>("private-text").value = workspace.report.text;
    byId<HTMLButtonElement>("reveal").disabled = false;
    byId("updated").textContent = `Updated ${new Date(workspace.report.updatedAt).toLocaleString()}${workspace.report.updatedBy ? ` by ${workspace.report.updatedBy}` : ""}`;
    renderAgents(workspace.agents);
    const activity = await request("/activity");
    if (version !== refreshVersion) return;
    byId("events").replaceChildren(...activity.events.slice(0, 8).map((event: { at: string; detail: string }) => {
      const item = document.createElement("p"); item.textContent = `${new Date(event.at).toLocaleTimeString()} · ${event.detail}`; return item;
    }));
  } catch (error) { status(error instanceof Error ? error.message : "Service B unavailable", true); }
  finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; void refreshWorkspace(); }
  }
}

byId<HTMLButtonElement>("register-wallet").addEventListener("click", async () => {
  const button = byId<HTMLButtonElement>("register-wallet");
  if (!window.ethereum) { status("Open this page in a browser with MetaMask or another wallet.", true); return; }
  button.disabled = true;
  try {
    const [owner] = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
    if (!owner) throw new Error("Select an owner wallet first");
    status("Sign in with your wallet. No gas or blockchain transaction is needed.");
    const challenge = await request("/owner/challenge", { method: "POST", body: JSON.stringify({ owner }) });
    const signature = await window.ethereum.request({ method: "personal_sign", params: [stringToHex(challenge.message), owner] });
    await request("/owner/register", { method: "POST", body: JSON.stringify({ owner, nonce: challenge.nonce, signature }) });
    agentRenderKey = ""; refreshVersion++;
    byId<HTMLInputElement>("private-text").type = "password";
    byId("reveal").textContent = "Show text";
    await refreshWorkspace();
    status("Signed in. Change checkboxes to control what each agent can do.");
  } catch (error) { status(error instanceof Error ? error.message : "Wallet sign-in failed", true); }
  finally { button.disabled = false; }
});
byId("reveal").addEventListener("click", () => {
  if (!workspace) return;
  const input = byId<HTMLInputElement>("private-text");
  input.type = input.type === "password" ? "text" : "password";
  byId("reveal").textContent = input.type === "password" ? "Show text" : "Hide text";
});
byId("refresh-button").addEventListener("click", () => { void refreshWorkspace(); });
byId("visit-instruction").textContent = `“Go to ${location.origin} and get my report.”`;
byId("write-instruction").textContent = `“Go to ${location.origin} and update my report to ‘Hello from my agent’.”`;
void request("/health").then(body => { byId("chain-label").textContent = `SEPOLIA · ${body.chainId}`; })
  .catch(error => { byId("chain-label").textContent = "SERVICE OFFLINE"; status(error.message, true); });
void refreshWorkspace();
setInterval(() => { if (!document.hidden && workspace) void refreshWorkspace(); }, 3000);
