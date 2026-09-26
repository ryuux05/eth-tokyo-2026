import { stringToHex } from "viem";

type Permission = "report" | "compute";
type Enrollment = { agentId: string; owner: string; scheme: string; permissions: Record<Permission, boolean> };
type Activity = { at: string; kind: string; agentId: string; detail: string };
type Challenge = { agentId: string; audience: string; chainId: number; nonce: string; issuedAt: number; expiresAt: number };

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const operatorInput = byId<HTMLInputElement>("operator-token");
const agentInput = byId<HTMLInputElement>("agent-id");
const proofInput = byId<HTMLTextAreaElement>("proof-input");
let operatorToken = "";
let selected: Enrollment | undefined;
let challenge: Challenge | undefined;
let sessionToken = "";
let sessionExpiry = 0;

async function request(path: string, init: RequestInit = {}, admin = false): Promise<{ status: number; body: any; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (admin) headers.set("X-Operator-Token", operatorToken);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  let body: any;
  try { body = await response.json(); } catch { body = { error: "Invalid service response" }; }
  return { status: response.status, body, headers: response.headers };
}

function setStatus(element: HTMLElement, message: string, isError = false): void {
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function showIdentity(): void {
  byId("identity-row").hidden = !selected;
  byId("owner-value").textContent = selected?.owner ?? "";
  byId("scheme-value").textContent = selected?.scheme ?? "";
  for (const resource of ["report", "compute"] as const) {
    const gate = document.querySelector<HTMLElement>(`.gate[data-resource="${resource}"]`)!;
    const button = gate.querySelector<HTMLButtonElement>("button")!;
    const allowed = selected?.permissions[resource] ?? false;
    gate.dataset.allowed = String(allowed);
    button.disabled = !selected || !operatorToken;
    button.textContent = !selected ? "Enroll agent first" : allowed ? "Revoke access" : "Grant access";
    button.setAttribute("aria-label", `${allowed ? "Revoke" : "Grant"} ${resource} access`);
  }
  byId<HTMLButtonElement>("challenge-button").disabled = !selected;
}

function showEvents(events: Activity[]): void {
  const container = byId("events");
  container.replaceChildren();
  if (!events.length) { const p = document.createElement("p"); p.textContent = "No service decisions yet."; container.append(p); return; }
  for (const event of events) {
    const row = document.createElement("div"); row.className = "event"; row.dataset.kind = event.kind;
    const time = document.createElement("time"); time.dateTime = event.at; time.textContent = new Date(event.at).toLocaleTimeString();
    const kind = document.createElement("span"); kind.className = "event-kind"; kind.textContent = event.kind;
    const detail = document.createElement("span"); detail.className = "event-details"; detail.textContent = `${event.detail} · ${event.agentId.slice(0, 8)}…`;
    row.append(time, kind, detail); container.append(row);
  }
}

async function refresh(): Promise<void> {
  if (!operatorToken) return;
  const result = await request("/admin/state", {}, true);
  if (result.status !== 200) throw new Error(result.body.error ?? "Could not read operator state");
  const enrollments = result.body.enrollments as Enrollment[];
  const address = selected?.agentId ?? agentInput.value.trim();
  selected = enrollments.find(enrollment => enrollment.agentId.toLowerCase() === address.toLowerCase());
  showIdentity(); showEvents(result.body.events as Activity[]);
}

byId<HTMLFormElement>("operator-form").addEventListener("submit", async event => {
  event.preventDefault();
  operatorToken = operatorInput.value.trim();
  try { await refresh(); setStatus(byId("operator-state"), "Desk unlocked. Operator changes stay local to this service."); }
  catch (error) { operatorToken = ""; showIdentity(); setStatus(byId("operator-state"), error instanceof Error ? error.message : "Could not unlock desk", true); }
});

byId<HTMLFormElement>("enroll-form").addEventListener("submit", async event => {
  event.preventDefault();
  const state = byId("enroll-state");
  try {
    const provider = (window as Window & { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!provider) throw new Error("Open Service A in a browser with your owner wallet installed.");
    const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
    if (!accounts.length) throw new Error("The wallet did not return an owner account.");
    const challengeResult = await request("/user/enrollment-challenge", { method: "POST", body: JSON.stringify({ agentId: agentInput.value.trim() }) });
    if (challengeResult.status !== 200) throw new Error(challengeResult.body.error ?? "Could not create enrollment challenge");
    const signature = await provider.request({ method: "personal_sign", params: [stringToHex(challengeResult.body.message as string), accounts[0]] });
    const result = await request("/user/enroll", { method: "POST", body: JSON.stringify({ agentId: challengeResult.body.agentId, nonce: challengeResult.body.nonce, signature }) });
    if (result.status !== 200) throw new Error(result.body.error ?? "Enrollment failed");
    selected = result.body as Enrollment; sessionToken = ""; sessionExpiry = 0; challenge = undefined;
    byId("challenge-output").hidden = true; byId("copy-challenge").hidden = true;
    setStatus(byId("session-state"), "No session yet");
    showIdentity(); await refresh();
    setStatus(state, `Your wallet enrolled ${selected.agentId}. Service permissions remain separate.`);
  } catch (error) { setStatus(state, error instanceof Error ? error.message : "Enrollment failed", true); }
});

document.querySelectorAll<HTMLButtonElement>(".gate-button").forEach(button => button.addEventListener("click", async () => {
  if (!selected) return;
  const resource = button.dataset.resource as Permission;
  button.disabled = true;
  try {
    const result = await request("/admin/permission", { method: "POST", body: JSON.stringify({ agentId: selected.agentId, resource, allowed: !selected.permissions[resource] }) }, true);
    if (result.status !== 200) throw new Error(result.body.error ?? "Permission update failed");
    selected = result.body as Enrollment; showIdentity(); await refresh();
    setStatus(byId("operator-state"), `${resource} is now ${selected.permissions[resource] ? "allowed" : "denied"}. Retry with the same AgentSession.`);
  } catch (error) { setStatus(byId("operator-state"), error instanceof Error ? error.message : "Permission update failed", true); }
  finally { showIdentity(); }
}));

byId<HTMLButtonElement>("challenge-button").addEventListener("click", async () => {
  if (!selected) return;
  try {
    const result = await request("/agent/challenge", { method: "POST", body: JSON.stringify({ agentId: selected.agentId }) });
    if (result.status !== 200) throw new Error(result.body.error ?? "Challenge failed");
    challenge = result.body as Challenge;
    const output = byId("challenge-output"); output.textContent = JSON.stringify(challenge, null, 2); output.hidden = false;
    byId("copy-challenge").hidden = false;
    setStatus(byId("session-state"), "Challenge ready. Sign it using agentic_session_proof, then paste the proof below.");
    if (operatorToken) await refresh();
  } catch (error) { setStatus(byId("session-state"), error instanceof Error ? error.message : "Challenge failed", true); }
});

byId<HTMLButtonElement>("copy-challenge").addEventListener("click", async () => {
  if (!challenge) return;
  try { await navigator.clipboard.writeText(JSON.stringify(challenge)); setStatus(byId("session-state"), "Challenge copied. Pass it to agentic_session_proof({ challenge })."); }
  catch { setStatus(byId("session-state"), "Select the challenge JSON above to copy it.", true); }
});

byId<HTMLButtonElement>("session-button").addEventListener("click", async () => {
  const state = byId("session-state");
  try {
    let proof: unknown = JSON.parse(proofInput.value);
    // Some MCP clients display structured output inside a proof wrapper.
    if (proof && typeof proof === "object" && "proof" in proof) proof = (proof as { proof: unknown }).proof;
    const result = await request("/agent/session", { method: "POST", body: JSON.stringify(proof) });
    if (result.status !== 200) throw new Error(result.body.error ?? "Session rejected");
    const token = result.headers.get("Agent-Session");
    if (!token) throw new Error("Service did not return Agent-Session");
    sessionToken = token; sessionExpiry = result.body.expiresAt as number;
    setStatus(state, `Session active for ${result.body.agentId.slice(0, 10)}… until ${new Date(sessionExpiry * 1000).toLocaleTimeString()}. Token is kept in this tab only.`);
    if (operatorToken) await refresh();
  } catch (error) { setStatus(state, error instanceof Error ? error.message : "Could not create session", true); }
});

document.querySelectorAll<HTMLButtonElement>("[data-try]").forEach(button => button.addEventListener("click", async () => {
  const resource = button.dataset.try as Permission;
  const resultNode = byId("result");
  try {
    const headers = new Headers();
    if (sessionToken) headers.set("Agent-Session", sessionToken);
    const result = await request(`/private/${resource}`, { headers });
    resultNode.className = `result ${result.status === 200 ? "allowed" : result.status === 403 ? "denied" : "error"}`;
    resultNode.replaceChildren();
    const code = document.createElement("span"); code.className = "result-code"; code.textContent = String(result.status);
    const content = document.createElement("div"); const title = document.createElement("strong");
    title.textContent = result.status === 200 ? `${resource} allowed` : result.status === 403 ? `${resource} denied` : "Authentication required";
    const detail = document.createElement("p"); detail.textContent = result.status === 200 ? JSON.stringify(result.body) : result.body.error ?? "Request failed";
    content.append(title, detail); resultNode.append(code, content);
    if (operatorToken) await refresh();
  } catch (error) { setStatus(byId("session-state"), error instanceof Error ? error.message : "Request failed", true); }
}));

byId<HTMLButtonElement>("refresh-button").addEventListener("click", async () => {
  try { await refresh(); } catch (error) { setStatus(byId("operator-state"), error instanceof Error ? error.message : "Refresh failed", true); }
});

void request("/health").then(({ body }) => { byId("chain-label").textContent = body.chainId === 11155111 ? "SEPOLIA · 11155111" : `CHAIN ${body.chainId} · 127.0.0.1`; }).catch(() => { byId("chain-label").textContent = "SERVICE OFFLINE"; });
showIdentity();
