import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  parseEther,
  parseUnits,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import {
  Decision, TOKEN_PURCHASE_SELECTOR, agentAccountAbi, agentPolicyAbi, agentRegistrationTypedData,
  decodePolicy, encodePolicy, isExpectedDelegation, mandateRegistryAbi, type PolicyRule,
} from "../sdk/core.js";
import { DEPLOYMENTS, type Deployment } from "./config.js";

type RuleKind = "native" | "token";
type DraftRule = {
  id: number;
  kind: RuleKind;
  target: string;
  selector: string;
  token: string;
  maxValue: string;
  maxAmount: string;
  decimals: string;
  decision: Decision;
};

type Permit = ReturnType<typeof agentRegistrationTypedData>;
const tokenMetadataAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
const purchaseAbi = [
  { type: "function", name: "purchaseCompute", stateMutability: "nonpayable", inputs: [
    { name: "token", type: "address" }, { name: "amount", type: "uint256" },
  ], outputs: [] },
] as const;

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
}

const ui = {
  connect: byId<HTMLButtonElement>("connectButton"),
  network: byId<HTMLElement>("networkBadge"),
  configNotice: byId<HTMLElement>("configNotice"),
  status: byId<HTMLElement>("statusMessage"),
  agent: byId<HTMLInputElement>("agentAddress"),
  verify: byId<HTMLButtonElement>("verifyButton"),
  identityState: byId<HTMLElement>("identityState"),
  identityDetails: byId<HTMLElement>("identityDetails"),
  delegation: byId<HTMLElement>("delegationValue"),
  owner: byId<HTMLElement>("ownerValue"),
  mandate: byId<HTMLElement>("mandateValue"),
  policyState: byId<HTMLElement>("policyState"),
  addNative: byId<HTMLButtonElement>("addNativeButton"),
  addToken: byId<HTMLButtonElement>("addTokenButton"),
  rules: byId<HTMLElement>("rulesList"),
  draftHash: byId<HTMLElement>("draftHash"),
  savePolicy: byId<HTMLButtonElement>("savePolicyButton"),
  previewSmall: byId<HTMLButtonElement>("previewSmallButton"),
  previewLarge: byId<HTMLButtonElement>("previewLargeButton"),
  previewResult: byId<HTMLOutputElement>("previewResult"),
  mandateState: byId<HTMLElement>("mandateState"),
  copyPermit: byId<HTMLButtonElement>("copyPermitButton"),
  permit: byId<HTMLElement>("permitPayload"),
  signature: byId<HTMLInputElement>("rootSignature"),
  register: byId<HTMLButtonElement>("registerButton"),
  summaryChain: byId<HTMLElement>("summaryChain"),
  summaryOwner: byId<HTMLElement>("summaryOwner"),
  summaryAgent: byId<HTMLElement>("summaryAgent"),
  summaryRuleCount: byId<HTMLElement>("summaryRuleCount"),
  summaryDecisions: byId<HTMLElement>("summaryDecisions"),
};

let provider: EIP1193Provider | undefined;
let owner: Address | undefined;
let chainId: number | undefined;
let deployment: Deployment | undefined;
let verifiedAgent: Address | undefined;
let registeredPrincipal: Address | undefined;
let currentPolicy: Hex = "0x";
let savedRules: PolicyRule[] = [];
let permit: Permit | undefined;
let busy = false;
let nextRuleId = 1;
const draftRules: DraftRule[] = [];

function short(address: string): string { return `${address.slice(0, 6)}…${address.slice(-4)}`; }
function matches(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function readableError(error: unknown): string {
  if (error && typeof error === "object" && "shortMessage" in error && typeof error.shortMessage === "string") return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}
function showStatus(message: string, kind: "info" | "error" = "info"): void {
  ui.status.hidden = false;
  ui.status.textContent = message;
  ui.status.className = kind === "error" ? "notice notice-error" : "notice";
}
function stateTag(node: HTMLElement, text: string, ready = false): void {
  node.textContent = text;
  node.classList.toggle("is-ready", ready);
}
function stringifyTypedData(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => typeof item === "bigint" ? item.toString() : item, 2);
}
function getClient() {
  if (!provider) throw new Error("Connect a wallet first.");
  return createPublicClient({ transport: custom(provider) });
}
function getWallet() {
  if (!provider || !owner) throw new Error("Connect the owner wallet first.");
  return createWalletClient({ transport: custom(provider) });
}
function requireContext() {
  if (!owner || !chainId || !deployment || !verifiedAgent) throw new Error("Connect the owner wallet and verify an agent first.");
  return { owner, chainId, deployment, agent: verifiedAgent };
}

function makeRule(kind: RuleKind): DraftRule {
  return {
    id: nextRuleId++, kind, target: "", selector: kind === "token" ? TOKEN_PURCHASE_SELECTOR : "",
    token: "", maxValue: "0", maxAmount: "0", decimals: "6", decision: Decision.ALLOW,
  };
}
function validateDraft(): Hex {
  const rules: PolicyRule[] = draftRules.map(rule => {
    if (!isAddress(rule.target) || matches(rule.target, zeroAddress)) throw new Error(`Rule ${draftRules.indexOf(rule) + 1}: enter a valid target address.`);
    if (rule.kind === "native") {
      if (!/^0x[0-9a-fA-F]{8}$/.test(rule.selector)) throw new Error(`Rule ${draftRules.indexOf(rule) + 1}: enter a 4-byte selector.`);
      return { target: getAddress(rule.target), selector: rule.selector as Hex, token: zeroAddress,
        maxValue: parseEther(rule.maxValue), maxAmount: 0n, decision: rule.decision };
    }
    if (!isAddress(rule.token) || matches(rule.token, zeroAddress)) throw new Error(`Rule ${draftRules.indexOf(rule) + 1}: enter a valid token address.`);
    const decimals = Number(rule.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`Rule ${draftRules.indexOf(rule) + 1}: token decimals must be 0–36.`);
    return { target: getAddress(rule.target), selector: TOKEN_PURCHASE_SELECTOR, token: getAddress(rule.token),
      maxValue: 0n, maxAmount: parseUnits(rule.maxAmount, decimals), decision: rule.decision };
  });
  return encodePolicy(rules);
}
function refreshActions(): void {
  ui.verify.disabled = busy || !owner || !deployment;
  let encoded: Hex | undefined;
  try {
    encoded = validateDraft();
    ui.draftHash.textContent = keccak256(encoded);
  } catch (error) {
    ui.draftHash.textContent = readableError(error);
  }
  ui.savePolicy.disabled = busy || !verifiedAgent || !encoded || encoded.toLowerCase() === currentPolicy.toLowerCase();
  const hasTokenRule = savedRules.some(rule => !matches(rule.token, zeroAddress));
  ui.previewSmall.disabled = busy || !verifiedAgent || !hasTokenRule;
  ui.previewLarge.disabled = busy || !verifiedAgent || !hasTokenRule;
  ui.copyPermit.disabled = busy || !permit || !!registeredPrincipal;
  ui.register.disabled = busy || !permit || !!registeredPrincipal || !/^0x[0-9a-fA-F]{130}$/.test(ui.signature.value.trim());
}
function setBusy(next: boolean): void {
  busy = next;
  ui.connect.disabled = next;
  ui.verify.disabled = next;
  refreshActions();
}
function renderSummary(): void {
  ui.summaryRuleCount.textContent = `${draftRules.length} draft ${draftRules.length === 1 ? "rule" : "rules"}`;
  ui.summaryDecisions.replaceChildren();
  if (!draftRules.length) {
    const p = document.createElement("p");
    p.textContent = "No rules yet. The agent cannot execute through its operating key.";
    ui.summaryDecisions.append(p);
    return;
  }
  draftRules.forEach((rule, index) => {
    const row = document.createElement("div");
    row.className = "summary-decision";
    const label = document.createElement("span");
    label.textContent = `${String(index + 1).padStart(2, "0")} / ${rule.kind === "token" ? "Token purchase" : "Native call"}`;
    const outcome = document.createElement("strong");
    outcome.textContent = rule.decision === Decision.ALLOW ? "ALLOW" : rule.decision === Decision.DENY ? "DENY" : "OWNER SIGNATURE";
    outcome.className = rule.decision === Decision.DENY ? "denied" : rule.decision === Decision.REQUIRE_OWNER_SIGNATURE ? "approval" : "";
    row.append(label, outcome);
    ui.summaryDecisions.append(row);
  });
}
function createTextField(labelText: string, value: string, onChange: (value: string) => void, options: { placeholder?: string; full?: boolean; type?: string } = {}) {
  const wrap = document.createElement("div");
  if (options.full) wrap.className = "full";
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = options.type ?? "text";
  input.value = value;
  input.placeholder = options.placeholder ?? "";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener("input", () => { onChange(input.value); refreshActions(); });
  label.append(input);
  wrap.append(label);
  return wrap;
}
function renderRules(): void {
  ui.rules.replaceChildren();
  if (!draftRules.length) {
    const empty = document.createElement("div");
    empty.className = "empty-rules";
    empty.textContent = "No custom rules. Add a supported action above, or save an empty policy to keep all operating-key execution denied.";
    ui.rules.append(empty);
  }
  draftRules.forEach((rule, index) => {
    const card = document.createElement("article");
    card.className = "rule-card";
    const head = document.createElement("div");
    head.className = "rule-card-head";
    const title = document.createElement("div");
    title.className = "rule-title";
    const number = document.createElement("span");
    number.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("div");
    name.textContent = rule.kind === "token" ? "Token purchase" : "Native call";
    const hint = document.createElement("em");
    hint.textContent = "First match wins";
    title.append(number, name, hint);
    const controls = document.createElement("div");
    controls.className = "rule-tools";
    for (const [symbol, label, delta] of [["↑", "Move rule up", -1], ["↓", "Move rule down", 1]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = symbol;
      button.setAttribute("aria-label", `${label}: rule ${index + 1}`);
      button.disabled = index + delta < 0 || index + delta >= draftRules.length;
      button.addEventListener("click", () => {
        const nextIndex = index + delta;
        [draftRules[index], draftRules[nextIndex]] = [draftRules[nextIndex], draftRules[index]];
        renderRules();
      });
      controls.append(button);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove rule ${index + 1}`);
    remove.addEventListener("click", () => { draftRules.splice(index, 1); renderRules(); });
    controls.append(remove);
    head.append(title, controls);
    const grid = document.createElement("div");
    grid.className = "rule-grid";
    grid.append(createTextField("Target contract", rule.target, value => { rule.target = value; }, { placeholder: "0x…", full: true }));
    if (rule.kind === "native") {
      grid.append(createTextField("Function selector", rule.selector, value => { rule.selector = value; }, { placeholder: "0x12345678" }));
      grid.append(createTextField("Maximum native value (ETH)", rule.maxValue, value => { rule.maxValue = value; }, { placeholder: "0.01" }));
    } else {
      grid.append(createTextField("Token contract", rule.token, value => { rule.token = value; }, { placeholder: "0x…", full: true }));
      grid.append(createTextField("Maximum token amount", rule.maxAmount, value => { rule.maxAmount = value; }, { placeholder: "5" }));
      grid.append(createTextField("Token decimals", rule.decimals, value => { rule.decimals = value; }, { type: "number" }));
    }
    const decisionWrap = document.createElement("div");
    decisionWrap.className = "full";
    const decisionLabel = document.createElement("label");
    decisionLabel.textContent = "Decision";
    const select = document.createElement("select");
    for (const [value, text] of [[Decision.ALLOW, "Allow without owner signature"], [Decision.REQUIRE_OWNER_SIGNATURE, "Require exact owner signature"], [Decision.DENY, "Deny"]] as const) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = text;
      select.append(option);
    }
    select.value = String(rule.decision);
    select.addEventListener("change", () => { rule.decision = Number(select.value) as Decision; renderSummary(); refreshActions(); });
    decisionLabel.append(select);
    decisionWrap.append(decisionLabel);
    grid.append(decisionWrap);
    card.append(head, grid);
    const p = document.createElement("p");
    p.className = "rule-hint";
    p.textContent = rule.kind === "token"
      ? "Only purchaseCompute(address token, uint256 amount) is supported. The contract reads that exact calldata shape; it does not inspect arbitrary token calls."
      : "Use selector 0x00000000 only for an empty-calldata native transfer. This rule cannot authorize the token purchase selector.";
    card.append(p);
    ui.rules.append(card);
  });
  renderSummary();
  refreshActions();
}

async function connectWallet(): Promise<void> {
  provider = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error("No injected wallet found. Install or open an Ethereum wallet, then try again.");
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as Address[];
  if (!accounts.length) throw new Error("The wallet did not return an account.");
  owner = getAddress(accounts[0]);
  chainId = await getClient().getChainId();
  deployment = DEPLOYMENTS[chainId];
  verifiedAgent = undefined;
  registeredPrincipal = undefined;
  permit = undefined;
  ui.connect.textContent = short(owner);
  ui.network.textContent = `Chain ${chainId}`;
  ui.network.classList.add("is-connected");
  ui.summaryChain.textContent = `Chain ${chainId}`;
  ui.summaryOwner.textContent = short(owner);
  ui.summaryAgent.textContent = "Not verified";
  stateTag(ui.identityState, "Waiting");
  stateTag(ui.mandateState, "Not registered");
  ui.identityDetails.hidden = true;
  ui.permit.textContent = "Verify an agent to prepare the registration permit.";
  ui.signature.value = "";
  if (!deployment) {
    ui.configNotice.hidden = false;
    ui.configNotice.textContent = `No Agentic World deployment is pinned for chain ${chainId}. Add trusted AgentAccount and MandateRegistry addresses in portal/config.ts before using this page.`;
  } else {
    ui.configNotice.hidden = true;
  }
  showStatus(`Connected owner wallet ${short(owner)}. Verify an existing agent account to continue.`);
  refreshActions();
}

async function verifyAgent(): Promise<void> {
  if (!owner || !chainId || !deployment) throw new Error("Connect a wallet on a configured chain first.");
  if (!isAddress(ui.agent.value)) throw new Error("Enter a valid agent address.");
  const agent = getAddress(ui.agent.value);
  const client = getClient();
  const code = await client.getCode({ address: agent });
  if (!isExpectedDelegation(code, deployment.implementation)) throw new Error("This address is not delegated to the pinned AgentAccount implementation on this chain.");
  const accountOwner = await client.readContract({ address: agent, abi: agentAccountAbi, functionName: "owner" });
  if (!matches(accountOwner, owner)) throw new Error(`The connected wallet is not this agent's owner. Current owner: ${accountOwner}.`);
  const principal = await client.readContract({ address: deployment.registry, abi: mandateRegistryAbi, functionName: "principalOf", args: [agent] });
  if (!matches(principal, zeroAddress) && !matches(principal, owner)) throw new Error(`This agent is already registered to another principal: ${principal}.`);
  const loadedPolicy = await client.readContract({ address: agent, abi: agentPolicyAbi, functionName: "policy" });
  const loadedRules = loadedPolicy === "0x" ? [] : decodePolicy(loadedPolicy);
  verifiedAgent = agent;
  registeredPrincipal = matches(principal, zeroAddress) ? undefined : principal;
  ui.identityDetails.hidden = false;
  ui.delegation.textContent = short(deployment.implementation);
  ui.owner.textContent = short(accountOwner);
  ui.mandate.textContent = registeredPrincipal ? "Registered to this owner" : "Not yet registered";
  ui.summaryAgent.textContent = short(agent);
  stateTag(ui.identityState, "Verified", true);
  stateTag(ui.mandateState, registeredPrincipal ? "Registered" : "Ready", !!registeredPrincipal);

  currentPolicy = loadedPolicy;
  savedRules = loadedRules;
  draftRules.splice(0, draftRules.length);
  for (const rule of savedRules) {
    const isToken = !matches(rule.token, zeroAddress);
    let decimals = 6;
    if (isToken) {
      try { decimals = await client.readContract({ address: rule.token, abi: tokenMetadataAbi, functionName: "decimals" }); }
      catch { decimals = 0; }
    }
    draftRules.push({ id: nextRuleId++, kind: isToken ? "token" : "native", target: rule.target,
      selector: rule.selector, token: isToken ? rule.token : "", maxValue: isToken ? "0" : formatUnits(rule.maxValue, 18),
      maxAmount: isToken ? formatUnits(rule.maxAmount, decimals) : "0", decimals: String(decimals), decision: rule.decision });
  }
  stateTag(ui.policyState, currentPolicy === "0x" ? "Default deny" : "Onchain policy", currentPolicy !== "0x");
  renderRules();

  if (registeredPrincipal) {
    permit = undefined;
    ui.permit.textContent = "This mandate is already registered. You can still edit the agent's execution policy above.";
  } else {
    const nonce = await client.readContract({ address: deployment.registry, abi: mandateRegistryAbi, functionName: "nonceOf", args: [agent] });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    permit = agentRegistrationTypedData({ agent, principal: owner, chainId, registry: deployment.registry, nonce, deadline });
    ui.permit.textContent = stringifyTypedData(permit);
  }
  ui.signature.value = "";
  refreshActions();
  showStatus(`Verified ${short(agent)}. Its owner is your connected wallet.`);
}

async function savePolicy(): Promise<void> {
  const { owner, agent } = requireContext();
  const encoded = validateDraft();
  if (encoded.toLowerCase() === currentPolicy.toLowerCase()) throw new Error("The draft matches the current onchain policy.");
  showStatus("Confirm the policy transaction in your owner wallet…");
  const hash = await getWallet().writeContract({ account: owner, chain: null, address: agent, abi: agentPolicyAbi, functionName: "setPolicy", args: [encoded] });
  showStatus(`Policy transaction ${short(hash)} submitted. Waiting for confirmation…`);
  const receipt = await getClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The policy transaction reverted. No changes were saved.");
  const onchainPolicy = await getClient().readContract({ address: agent, abi: agentPolicyAbi, functionName: "policy" });
  if (onchainPolicy.toLowerCase() !== encoded.toLowerCase()) throw new Error("The transaction succeeded but the onchain policy differs from the draft. Refresh and check the agent account.");
  currentPolicy = onchainPolicy;
  savedRules = decodePolicy(onchainPolicy);
  stateTag(ui.policyState, "Onchain policy", true);
  refreshActions();
  showStatus(`Policy saved onchain. Hash: ${keccak256(encoded)}.`);
}

async function previewAmount(amount: string): Promise<void> {
  const { agent } = requireContext();
  const rule = savedRules.find(item => !matches(item.token, zeroAddress));
  if (!rule) throw new Error("Save a token purchase rule before previewing.");
  let decimals = 6;
  try { decimals = await getClient().readContract({ address: rule.token, abi: tokenMetadataAbi, functionName: "decimals" }); }
  catch { throw new Error("Cannot read token decimals. Check the configured token contract."); }
  const data = encodeFunctionData({ abi: purchaseAbi, functionName: "purchaseCompute", args: [rule.token, parseUnits(amount, decimals)] });
  const decision = await getClient().readContract({ address: agent, abi: agentPolicyAbi, functionName: "evaluateAction", args: [rule.target, 0n, data] });
  const label = decision === Decision.ALLOW ? "ALLOW — no owner signature" : decision === Decision.REQUIRE_OWNER_SIGNATURE ? "REQUIRE OWNER SIGNATURE" : "DENY";
  ui.previewResult.textContent = `${amount} token units → ${label}. This previews the saved onchain policy, not the draft.`;
}

async function registerMandate(): Promise<void> {
  const { owner, deployment, agent } = requireContext();
  if (!permit || registeredPrincipal) throw new Error("The mandate is already registered or no permit is ready.");
  const signature = ui.signature.value.trim() as Hex;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Paste a 65-byte agent-root signature.");
  if (Number(permit.message.deadline) < Math.floor(Date.now() / 1000)) throw new Error("The permit expired. Verify the agent again for a fresh one.");
  const signer = await recoverTypedDataAddress({ ...permit, signature });
  if (!matches(signer, agent)) throw new Error(`Signature recovered ${signer}, not the agent root ${agent}.`);
  showStatus("Confirm the mandate registration in your owner wallet…");
  const hash = await getWallet().writeContract({ account: owner, chain: null, address: deployment.registry, abi: mandateRegistryAbi,
    functionName: "register", args: [agent, permit.message.nonce, permit.message.deadline, signature] });
  showStatus(`Mandate transaction ${short(hash)} submitted. Waiting for confirmation…`);
  const receipt = await getClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The registration transaction reverted. The mandate was not recorded.");
  const principal = await getClient().readContract({ address: deployment.registry, abi: mandateRegistryAbi, functionName: "principalOf", args: [agent] });
  if (!matches(principal, owner)) throw new Error("The transaction succeeded but the registry does not show this owner. Refresh and inspect the registry.");
  registeredPrincipal = owner;
  permit = undefined;
  ui.signature.value = "";
  ui.mandate.textContent = "Registered to this owner";
  ui.permit.textContent = "Mandate registered. No further root signature is needed for this registration.";
  stateTag(ui.mandateState, "Registered", true);
  refreshActions();
  showStatus(`Mandate registered onchain for ${short(agent)} and owner ${short(owner)}.`);
}

function bind(): void {
  ui.connect.addEventListener("click", () => void run(connectWallet));
  ui.verify.addEventListener("click", () => void run(verifyAgent));
  ui.addNative.addEventListener("click", () => { draftRules.push(makeRule("native")); renderRules(); });
  ui.addToken.addEventListener("click", () => { draftRules.push(makeRule("token")); renderRules(); });
  ui.savePolicy.addEventListener("click", () => void run(savePolicy));
  ui.previewSmall.addEventListener("click", () => void run(() => previewAmount("2")));
  ui.previewLarge.addEventListener("click", () => void run(() => previewAmount("20")));
  ui.copyPermit.addEventListener("click", () => void run(async () => {
    if (!permit) throw new Error("Verify an agent first.");
    await navigator.clipboard.writeText(stringifyTypedData(permit));
    showStatus("Typed data copied. Sign it with the agent root key outside this page.");
  }));
  ui.signature.addEventListener("input", refreshActions);
  ui.register.addEventListener("click", () => void run(registerMandate));
  const injected = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  injected?.on?.("accountsChanged", () => { window.location.reload(); });
  injected?.on?.("chainChanged", () => { window.location.reload(); });
  renderRules();
}
async function run(action: () => Promise<void>): Promise<void> {
  try { setBusy(true); await action(); }
  catch (error) { showStatus(readableError(error), "error"); }
  finally { setBusy(false); }
}

bind();
