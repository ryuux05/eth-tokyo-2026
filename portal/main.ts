import {
  createPublicClient, createWalletClient, custom, encodeFunctionData, formatUnits, getAddress,
  isAddress, keccak256, parseEther, parseUnits, zeroAddress,
  type Address, type EIP1193Provider, type Hex,
} from "viem";
import {
  Decision, TOKEN_PURCHASE_SELECTOR, agentAccountAbi, agentAccountFactoryAbi, agentPolicyAbi,
  decodePolicy, encodePolicy, isExpectedAgentClone, type PolicyRule,
} from "../sdk/core.js";
import { DEPLOYMENTS, type Deployment } from "./config.js";
import { validP256PublicKey } from "./p256.js";

type RuleKind = "native" | "token";
type OperatingKey = { scheme: "p256"; qx: Hex; qy: Hex } | { scheme: "secp256k1"; address: Address };
type DraftRule = {
  id: number; kind: RuleKind; target: string; selector: string; token: string;
  maxValue: string; maxAmount: string; decimals: string; decision: Decision;
};

const tokenMetadataAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
const purchaseAbi = [
  { type: "function", name: "purchaseCompute", stateMutability: "nonpayable", inputs: [
    { name: "token", type: "address" }, { name: "amount", type: "uint256" },
  ], outputs: [] },
] as const;

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
}

const ui = {
  managedSection: element<HTMLElement>("managedSection"), managedCount: element<HTMLElement>("managedCount"),
  managedList: element<HTMLElement>("managedList"), refreshManaged: element<HTMLButtonElement>("refreshManagedButton"),
  connect: element<HTMLButtonElement>("connectButton"), network: element<HTMLElement>("networkBadge"),
  configNotice: element<HTMLElement>("configNotice"), status: element<HTMLElement>("statusMessage"),
  creationAlias: element<HTMLInputElement>("creationAlias"),
  creationScheme: element<HTMLSelectElement>("creationScheme"),
  creationP256Fields: element<HTMLElement>("creationP256Fields"),
  creationLegacyFields: element<HTMLElement>("creationLegacyFields"),
  creationQx: element<HTMLInputElement>("creationQx"), creationQy: element<HTMLInputElement>("creationQy"),
  authenticator: element<HTMLInputElement>("authenticatorInput"), salt: element<HTMLInputElement>("saltInput"),
  newSalt: element<HTMLButtonElement>("newSaltButton"), predicted: element<HTMLElement>("predictedAgent"),
  create: element<HTMLButtonElement>("createButton"), agent: element<HTMLInputElement>("agentAddress"),
  verify: element<HTMLButtonElement>("verifyButton"), identityState: element<HTMLElement>("identityState"),
  identityDetails: element<HTMLElement>("identityDetails"), activeAgent: element<HTMLElement>("activeAgent"),
  ownerValue: element<HTMLElement>("ownerValue"), validatorValue: element<HTMLElement>("validatorValue"),
  policyHookValue: element<HTMLElement>("policyHookValue"), entryPointValue: element<HTMLElement>("entryPointValue"),
  signerState: element<HTMLElement>("signerState"), signerValue: element<HTMLElement>("signerValue"),
  replacementP256Fields: element<HTMLElement>("replacementP256Fields"),
  replacementLegacyFields: element<HTMLElement>("replacementLegacyFields"),
  replacementQx: element<HTMLInputElement>("replacementQx"), replacementQy: element<HTMLInputElement>("replacementQy"),
  replacement: element<HTMLInputElement>("rotationInput"), rotate: element<HTMLButtonElement>("rotateButton"),
  restore: element<HTMLButtonElement>("restoreButton"), revoke: element<HTMLButtonElement>("revokeButton"),
  policyState: element<HTMLElement>("policyState"), addNative: element<HTMLButtonElement>("addNativeButton"),
  addToken: element<HTMLButtonElement>("addTokenButton"), rules: element<HTMLElement>("rulesList"),
  draftHash: element<HTMLElement>("draftHash"), savePolicy: element<HTMLButtonElement>("savePolicyButton"),
  previewSmall: element<HTMLButtonElement>("previewSmallButton"), previewLarge: element<HTMLButtonElement>("previewLargeButton"),
  previewResult: element<HTMLOutputElement>("previewResult"), summaryChain: element<HTMLElement>("summaryChain"),
  summaryOwner: element<HTMLElement>("summaryOwner"), summaryAgent: element<HTMLElement>("summaryAgent"),
  summarySigner: element<HTMLElement>("summarySigner"), summaryPolicy: element<HTMLElement>("summaryPolicy"),
};

let provider: EIP1193Provider | undefined;
let owner: Address | undefined;
let chainId: number | undefined;
let deployment: Deployment | undefined;
let demoFingerprint: { number: bigint; hash: Hex } | undefined;
let verifiedAgent: Address | undefined;
let currentKey: OperatingKey | undefined;
let revoked = false;
let currentPolicy: Hex = "0x";
let savedRules: PolicyRule[] = [];
let predictedAgent: Address | undefined;
let predictionSequence = 0;
let busy = false;
let nextRuleId = 1;
const draftRules: DraftRule[] = [];
type ManagedIdentity = { agentId: Address; alias: string | null; owner?: Address; status: "ACTIVE" | "REVOKED" | "UNAVAILABLE" };

async function refreshManaged(): Promise<void> {
  let response: Response;
  try { response = await fetch(new URL("api/identities", location.href), { cache: "no-store" }); }
  catch { return; }
  if (!response.ok) return;
  const data = await response.json() as { count: number; identities: ManagedIdentity[] };
  ui.managedSection.hidden = false;
  ui.managedCount.textContent = String(data.count);
  ui.managedList.replaceChildren();
  if (!data.count) {
    const empty = document.createElement("p"); empty.className = "managed-empty";
    empty.textContent = "No local agent IDs yet. Use agentic-world:create -a \"name\" to create one.";
    ui.managedList.append(empty); return;
  }
  for (const entry of data.identities) {
    const row = document.createElement("div"); row.className = "managed-row";
    const identity = document.createElement("div"); identity.className = "managed-identity";
    const name = document.createElement("strong"); name.textContent = entry.alias ?? "Unnamed agent";
    const address = document.createElement("code"); address.textContent = entry.agentId;
    identity.append(name, address);
    const state = document.createElement("span"); state.className = `managed-status ${entry.status.toLowerCase()}`;
    state.textContent = entry.status === "ACTIVE" ? "Active" : entry.status === "REVOKED" ? "Revoked" : "Unavailable";
    const alias = document.createElement("input"); alias.type = "text"; alias.maxLength = 40;
    alias.placeholder = "Add an alias"; alias.value = entry.alias ?? "";
    alias.setAttribute("aria-label", `Alias for ${entry.agentId}`);
    const save = document.createElement("button"); save.type = "button"; save.className = "button button-secondary"; save.textContent = "Save alias";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const result = await fetch(new URL("api/alias", location.href), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: entry.agentId, alias: alias.value }) });
        if (!result.ok) throw new Error("Alias must be 1–40 printable characters.");
        await refreshManaged();
      } catch (error) { status(readableError(error), "error"); }
      finally { save.disabled = false; }
    });
    const open = document.createElement("button"); open.type = "button"; open.className = "button button-primary"; open.textContent = "Manage";
    open.addEventListener("click", () => {
      ui.agent.value = entry.agentId;
      if (!owner) { status("Connect the owner wallet, then manage this agent."); refresh(); return; }
      void action(() => verifyAgent(entry.agentId));
    });
    row.append(identity, state, alias, save, open); ui.managedList.append(row);
  }
}

function short(value: string): string { return `${value.slice(0, 6)}…${value.slice(-4)}`; }
function same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function readableError(error: unknown): string {
  if (error && typeof error === "object" && "shortMessage" in error && typeof error.shortMessage === "string") return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}
function status(message: string, kind: "info" | "error" = "info"): void {
  ui.status.hidden = false;
  ui.status.textContent = message;
  ui.status.className = kind === "error" ? "notice notice-error" : "notice";
}
function tag(node: HTMLElement, label: string, state: "ready" | "danger" | "neutral" = "neutral"): void {
  node.textContent = label;
  node.classList.toggle("is-ready", state === "ready");
  node.classList.toggle("is-danger", state === "danger");
}
function client() {
  if (!provider) throw new Error("Connect an owner wallet first.");
  return createPublicClient({ transport: custom(provider) });
}
function wallet() {
  if (!provider || !owner) throw new Error("Connect an owner wallet first.");
  return createWalletClient({ transport: custom(provider) });
}
function context() {
  if (!owner || !chainId || !deployment || !verifiedAgent) throw new Error("Connect your wallet and verify an agent first.");
  return { owner, chainId, deployment, agent: verifiedAgent };
}
function newSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
function validSigner(value: string): value is Address {
  return !!owner && isAddress(value) && !same(value, zeroAddress) && !same(value, owner) &&
    (!verifiedAgent || !same(value, verifiedAgent)) && (!predictedAgent || !same(value, predictedAgent));
}
function creationKeyValid(): boolean {
  return ui.creationScheme.value === "p256"
    ? validP256PublicKey(ui.creationQx.value.trim(), ui.creationQy.value.trim())
    : validSigner(ui.authenticator.value.trim());
}
function replacementKeyValid(): boolean {
  if (!currentKey) return false;
  if (currentKey.scheme === "p256") {
    const qx = ui.replacementQx.value.trim(); const qy = ui.replacementQy.value.trim();
    return validP256PublicKey(qx, qy) && (!same(qx, currentKey.qx) || !same(qy, currentKey.qy));
  }
  const address = ui.replacement.value.trim();
  return validSigner(address) && !same(address, currentKey.address);
}
function keyLabel(key: OperatingKey): string {
  return key.scheme === "p256" ? `P-256 · qx ${key.qx} · qy ${key.qy}` : `secp256k1 · ${key.address}`;
}
function renderKeyFields(): void {
  ui.creationP256Fields.hidden = ui.creationScheme.value !== "p256";
  ui.creationLegacyFields.hidden = ui.creationScheme.value === "p256";
  ui.replacementP256Fields.hidden = currentKey?.scheme !== "p256";
  ui.replacementLegacyFields.hidden = currentKey?.scheme !== "secp256k1";
}
function validSalt(value: string): value is Hex { return /^0x[0-9a-fA-F]{64}$/.test(value); }

function makeRule(kind: RuleKind): DraftRule {
  return { id: nextRuleId++, kind, target: "", selector: kind === "token" ? TOKEN_PURCHASE_SELECTOR : "",
    token: "", maxValue: "0", maxAmount: "0", decimals: "6", decision: Decision.ALLOW };
}
function encodeDraft(): Hex {
  const rules: PolicyRule[] = draftRules.map((rule, index) => {
    if (!isAddress(rule.target) || same(rule.target, zeroAddress)) throw new Error(`Rule ${index + 1}: enter a valid target contract.`);
    if (rule.kind === "native") {
      if (!/^0x[0-9a-fA-F]{8}$/.test(rule.selector)) throw new Error(`Rule ${index + 1}: enter a 4-byte selector.`);
      return { target: getAddress(rule.target), selector: rule.selector as Hex, token: zeroAddress,
        maxValue: parseEther(rule.maxValue), maxAmount: 0n, decision: rule.decision };
    }
    if (!isAddress(rule.token) || same(rule.token, zeroAddress)) throw new Error(`Rule ${index + 1}: enter a valid token contract.`);
    const decimals = Number(rule.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`Rule ${index + 1}: decimals must be 0–36.`);
    return { target: getAddress(rule.target), selector: TOKEN_PURCHASE_SELECTOR, token: getAddress(rule.token),
      maxValue: 0n, maxAmount: parseUnits(rule.maxAmount, decimals), decision: rule.decision };
  });
  return encodePolicy(rules);
}
function refresh(): void {
  renderKeyFields();
  ui.connect.disabled = busy;
  ui.newSalt.disabled = busy;
  ui.predicted.textContent = predictedAgent ?? (owner && deployment ? "Enter a valid 32-byte salt" : "Connect a wallet to preview");
  ui.create.disabled = busy || !owner || !deployment || !predictedAgent || !creationKeyValid();
  ui.verify.disabled = busy || !owner || !deployment || !isAddress(ui.agent.value.trim());
  ui.rotate.disabled = busy || !verifiedAgent || revoked || !replacementKeyValid();
  ui.restore.disabled = busy || !verifiedAgent || !revoked || !replacementKeyValid();
  ui.revoke.disabled = busy || !verifiedAgent || revoked;
  ui.addNative.disabled = busy || !verifiedAgent;
  ui.addToken.disabled = busy || !verifiedAgent;
  let encoded: Hex | undefined;
  try { encoded = encodeDraft(); ui.draftHash.textContent = keccak256(encoded); }
  catch (error) { ui.draftHash.textContent = readableError(error); }
  ui.savePolicy.disabled = busy || !verifiedAgent || !encoded || same(encoded, currentPolicy);
  const hasSavedTokenRule = savedRules.some(rule => !same(rule.token, zeroAddress));
  ui.previewSmall.disabled = busy || !verifiedAgent || !hasSavedTokenRule;
  ui.previewLarge.disabled = busy || !verifiedAgent || !hasSavedTokenRule;
}
function setBusy(value: boolean): void { busy = value; refresh(); }
async function action(run: () => Promise<void>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try { await run(); } catch (error) { status(readableError(error), "error"); }
  finally { setBusy(false); }
}

function field(labelText: string, value: string, change: (value: string) => void, options: { full?: boolean; placeholder?: string; type?: string } = {}): HTMLElement {
  const label = document.createElement("label");
  if (options.full) label.className = "full";
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = options.type ?? "text";
  input.value = value;
  input.placeholder = options.placeholder ?? "";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.addEventListener("input", () => { change(input.value); refresh(); });
  label.append(input);
  return label;
}
function renderRules(): void {
  ui.rules.replaceChildren();
  if (!draftRules.length) {
    const empty = document.createElement("div");
    empty.className = "empty-rules";
    empty.textContent = "No rules yet. The operating signer cannot execute onchain actions. Add a rule only for a target you trust.";
    ui.rules.append(empty);
  }
  draftRules.forEach((rule, index) => {
    const article = document.createElement("article"); article.className = "rule-card";
    const head = document.createElement("div"); head.className = "rule-head";
    const title = document.createElement("div"); title.className = "rule-heading";
    const number = document.createElement("span"); number.className = "rule-index"; number.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("strong"); name.textContent = rule.kind === "token" ? "Token purchase" : "Native call";
    title.append(number, name);
    const tools = document.createElement("div"); tools.className = "rule-tools";
    for (const [symbol, label, delta] of [["↑", "Move up", -1], ["↓", "Move down", 1]] as const) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = symbol;
      button.setAttribute("aria-label", `${label}: rule ${index + 1}`);
      button.disabled = index + delta < 0 || index + delta >= draftRules.length;
      button.addEventListener("click", () => { [draftRules[index], draftRules[index + delta]] = [draftRules[index + delta], draftRules[index]]; renderRules(); });
      tools.append(button);
    }
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove rule ${index + 1}`);
    remove.addEventListener("click", () => { draftRules.splice(index, 1); renderRules(); });
    tools.append(remove); head.append(title, tools);
    const grid = document.createElement("div"); grid.className = "rule-grid";
    grid.append(field("Target contract", rule.target, value => { rule.target = value; }, { full: true, placeholder: "0x…" }));
    if (rule.kind === "native") {
      grid.append(field("Function selector", rule.selector, value => { rule.selector = value; }, { placeholder: "0x12345678" }));
      grid.append(field("Maximum native value (ETH)", rule.maxValue, value => { rule.maxValue = value; }, { placeholder: "0.01" }));
    } else {
      grid.append(field("Token contract", rule.token, value => { rule.token = value; }, { full: true, placeholder: "0x…" }));
      grid.append(field("Maximum token amount", rule.maxAmount, value => { rule.maxAmount = value; }, { placeholder: "5" }));
      grid.append(field("Token decimals", rule.decimals, value => { rule.decimals = value; }, { type: "number" }));
    }
    const decisionLabel = document.createElement("label"); decisionLabel.className = "full"; decisionLabel.textContent = "Decision";
    const select = document.createElement("select");
    for (const [decision, text] of [[Decision.ALLOW, "Allow"], [Decision.REQUIRE_OWNER_SIGNATURE, "Require exact owner signature"], [Decision.DENY, "Deny"]] as const) {
      const option = document.createElement("option"); option.value = String(decision); option.textContent = text; select.append(option);
    }
    select.value = String(rule.decision);
    select.addEventListener("change", () => { rule.decision = Number(select.value) as Decision; refresh(); });
    decisionLabel.append(select); grid.append(decisionLabel);
    const hint = document.createElement("p"); hint.className = "rule-hint";
    hint.textContent = rule.kind === "token"
      ? "Only purchaseCompute(address token,uint256 amount) is decoded. This is a per-call limit, not a cumulative budget."
      : "Selector 0x00000000 matches only an empty-calldata native transfer.";
    article.append(head, grid, hint); ui.rules.append(article);
  });
  ui.summaryPolicy.textContent = `${draftRules.length} draft ${draftRules.length === 1 ? "rule" : "rules"}`;
  refresh();
}

async function assertFactory(): Promise<void> {
  if (!deployment) throw new Error("No pinned deployment for this chain.");
  await assertChain();
  const actual = await client().readContract({ address: deployment.factory, abi: agentAccountFactoryAbi, functionName: "implementation" });
  if (!same(actual, deployment.implementation)) throw new Error("Configured factory does not point to the pinned account implementation.");
}
async function assertChain(): Promise<void> {
  if (!chainId || await client().getChainId() !== chainId) throw new Error("Wallet network changed. Reconnect the owner wallet before continuing.");
}
async function updatePrediction(): Promise<void> {
  const sequence = ++predictionSequence;
  predictedAgent = undefined;
  if (owner && deployment && validSalt(ui.salt.value.trim())) {
    const salt = ui.salt.value.trim() as Hex;
    const predicted = await client().readContract({ address: deployment.factory, abi: agentAccountFactoryAbi,
      functionName: "predictAgent", args: [owner, salt] });
    if (sequence === predictionSequence && ui.salt.value.trim() === salt) predictedAgent = predicted;
  }
  refresh();
}
async function connect(): Promise<void> {
  provider = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error("No injected Ethereum wallet found. Open this page in a wallet-enabled browser.");
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as Address[];
  if (!accounts.length) throw new Error("The wallet did not return an account.");
  owner = getAddress(accounts[0]);
  chainId = await client().getChainId();
  deployment = DEPLOYMENTS[chainId];
  demoFingerprint = undefined;
  try {
    const response = await fetch("/demo-deployment.json", { cache: "no-store" });
    if (response.ok) {
      const local: unknown = await response.json();
      if (local && typeof local === "object" && "chainId" in local && local.chainId === chainId &&
          "factory" in local && typeof local.factory === "string" && isAddress(local.factory) &&
          "implementation" in local && typeof local.implementation === "string" && isAddress(local.implementation) &&
          "deploymentBlockNumber" in local && typeof local.deploymentBlockNumber === "string" && /^\d+$/.test(local.deploymentBlockNumber) &&
          "deploymentBlockHash" in local && typeof local.deploymentBlockHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(local.deploymentBlockHash)) {
        deployment = { factory: getAddress(local.factory), implementation: getAddress(local.implementation) };
        demoFingerprint = { number: BigInt(local.deploymentBlockNumber), hash: local.deploymentBlockHash as Hex };
      }
    }
  } catch { /* Standalone portal uses its checked-in pins. */ }
  verifiedAgent = undefined; predictedAgent = undefined; currentKey = undefined; revoked = false;
  currentPolicy = "0x"; savedRules = []; draftRules.splice(0, draftRules.length);
  ui.summaryPolicy.textContent = "0 draft rules";
  renderRules();
  ui.identityDetails.hidden = true;
  tag(ui.identityState, "Waiting"); tag(ui.signerState, "Load an agent"); tag(ui.policyState, "Default deny");
  ui.summaryOwner.textContent = short(owner); ui.summaryAgent.textContent = "Not loaded"; ui.summarySigner.textContent = "Not loaded";
  ui.summaryChain.textContent = `Chain ${chainId}`; ui.network.textContent = `Chain ${chainId}`;
  ui.network.classList.add("is-connected"); ui.connect.textContent = short(owner);
  if (!deployment) {
    ui.configNotice.hidden = false;
    ui.configNotice.textContent = `No v0 deployment is pinned for chain ${chainId}. Add its factory and implementation addresses to portal/config.ts before creating or verifying an agent.`;
  } else {
    try {
      if (demoFingerprint) {
        const block = await client().getBlock({ blockNumber: demoFingerprint.number });
        if (block.hash.toLowerCase() !== demoFingerprint.hash.toLowerCase()) {
          throw new Error("Wallet RPC is pointed at a different local Hardhat node. Set it to the RPC URL printed by npm run demo.");
        }
      }
      await assertFactory();
      ui.configNotice.hidden = true;
      await updatePrediction();
    } catch (error) {
      deployment = undefined;
      ui.configNotice.hidden = false;
      ui.configNotice.textContent = `Configured deployment failed verification: ${readableError(error)}`;
      throw error;
    }
  }
  status(`Owner wallet ${short(owner)} connected. ${deployment ? "Create or load an agent to continue." : "Configure this chain's deployment to continue."}`);
  refresh();
  if (isAddress(ui.agent.value.trim()) && deployment) await verifyAgent(getAddress(ui.agent.value.trim()));
}

async function createAgent(): Promise<void> {
  if (!owner || !deployment || !creationKeyValid() || !validSalt(ui.salt.value.trim())) {
    throw new Error("Connect your owner wallet, enter a valid operating public key, and use a valid 32-byte salt.");
  }
  await assertFactory();
  const predicted = await client().readContract({ address: deployment.factory, abi: agentAccountFactoryAbi,
    functionName: "predictAgent", args: [owner, ui.salt.value.trim() as Hex] });
  status("Confirm the factory transaction in your owner wallet. The factory will store your wallet as owner().");
  const hash = ui.creationScheme.value === "p256"
    ? await wallet().writeContract({ account: owner, chain: null, address: deployment.factory,
      abi: agentAccountFactoryAbi, functionName: "createAgentP256",
      args: [ui.creationQx.value.trim() as Hex, ui.creationQy.value.trim() as Hex, ui.salt.value.trim() as Hex] })
    : await wallet().writeContract({ account: owner, chain: null, address: deployment.factory,
      abi: agentAccountFactoryAbi, functionName: "createAgent", args: [getAddress(ui.authenticator.value.trim()), ui.salt.value.trim() as Hex] });
  status(`Deployment ${short(hash)} submitted. Waiting for confirmation…`);
  const receipt = await client().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Deployment reverted. No agent was created.");
  ui.agent.value = predicted;
  await verifyAgent(predicted);
  const alias = ui.creationAlias.value.trim();
  if (!ui.managedSection.hidden) {
    const registration = await fetch(new URL("api/adopt", location.href), { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: predicted, alias }) });
    if (!registration.ok)
      throw new Error("Agent was created onchain, but this portal could not add it to the local list. Do not repeat the transaction; load the address manually.");
  }
  status(`Agent ${short(predicted)} created and verified. Its owner is ${short(owner)}.`);
  await refreshManaged();
}

async function verifyAgent(input?: Address): Promise<void> {
  if (!owner || !deployment) throw new Error("Connect a wallet on a configured chain first.");
  const value = input ?? ui.agent.value.trim();
  if (!isAddress(value)) throw new Error("Enter a valid agent address.");
  const agent = getAddress(value);
  await assertFactory();
  const blockNumber = await client().getBlockNumber();
  const code = await client().getCode({ address: agent, blockNumber });
  if (!isExpectedAgentClone(code, deployment.implementation)) throw new Error("This is not a clone of the pinned v0 implementation on this chain.");
  const [accountOwner, version, scheme, validator, hook, factoryValidator, factoryHook, entryPoint, signer, coordinates, isRevoked, loadedPolicy] = await Promise.all([
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "owner", blockNumber }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "protocolVersion", blockNumber }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "authenticatorScheme", blockNumber }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "agentValidator", blockNumber }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "policyHook", blockNumber }),
    client().readContract({ address: deployment.factory, abi: agentAccountFactoryAbi, functionName: "validator", blockNumber }),
    client().readContract({ address: deployment.factory, abi: agentAccountFactoryAbi, functionName: "policyHook", blockNumber }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "entryPoint", blockNumber }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "authenticator", blockNumber }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "authenticatorP256", blockNumber }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "authenticationRevoked", blockNumber }),
    client().readContract({ address: agent, abi: agentPolicyAbi, functionName: "policy", blockNumber }),
  ]);
  if (!same(accountOwner, owner)) throw new Error(`This account is owned by another wallet (${accountOwner}).`);
  if (!((version === 3n && scheme === 2) || (version === 2n && scheme === 1))) {
    throw new Error("Unsupported account version or operating key scheme.");
  }
  if (!same(validator, factoryValidator) || !same(hook, factoryHook)) throw new Error("Account modules differ from the pinned factory.");
  const [validatorInstalled, hookInstalled] = await Promise.all([
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "isModuleInstalled", args: [1n, validator, "0x"], blockNumber }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "isModuleInstalled", args: [4n, hook, "0x"], blockNumber }),
  ]);
  if (!validatorInstalled || !hookInstalled) throw new Error("The required validator or policy hook is not installed.");
  verifiedAgent = agent;
  currentKey = scheme === 2
    ? { scheme: "p256", qx: coordinates[0], qy: coordinates[1] }
    : { scheme: "secp256k1", address: signer };
  revoked = isRevoked;
  currentPolicy = loadedPolicy; savedRules = loadedPolicy === "0x" ? [] : decodePolicy(loadedPolicy);
  ui.agent.value = agent; ui.identityDetails.hidden = false;
  ui.activeAgent.textContent = agent; ui.ownerValue.textContent = accountOwner;
  ui.validatorValue.textContent = validator; ui.policyHookValue.textContent = hook; ui.entryPointValue.textContent = entryPoint;
  ui.summaryAgent.textContent = short(agent);
  tag(ui.identityState, "Verified", "ready");
  renderSigner();
  draftRules.splice(0, draftRules.length);
  for (const rule of savedRules) {
    const tokenRule = !same(rule.token, zeroAddress);
    let decimals = 6;
    if (tokenRule) {
      try { decimals = await client().readContract({ address: rule.token, abi: tokenMetadataAbi, functionName: "decimals" }); }
      catch { decimals = 0; }
    }
    draftRules.push({ id: nextRuleId++, kind: tokenRule ? "token" : "native", target: rule.target,
      selector: rule.selector, token: tokenRule ? rule.token : "", maxValue: tokenRule ? "0" : formatUnits(rule.maxValue, 18),
      maxAmount: tokenRule ? formatUnits(rule.maxAmount, decimals) : "0", decimals: String(decimals), decision: rule.decision });
  }
  tag(ui.policyState, currentPolicy === "0x" ? "Default deny" : "Onchain policy", currentPolicy === "0x" ? "neutral" : "ready");
  renderRules();
  status(`Verified ${short(agent)}. Review its signer and saved policy below.`);
}

function renderSigner(): void {
  ui.signerValue.textContent = currentKey ? keyLabel(currentKey) : "—";
  ui.summarySigner.textContent = currentKey
    ? currentKey.scheme === "p256" ? `P-256 ${short(currentKey.qx)}` : short(currentKey.address)
    : "Not loaded";
  tag(ui.signerState, revoked ? "Revoked" : "Active", revoked ? "danger" : "ready");
  refresh();
}
async function refreshSigner(): Promise<void> {
  const { agent } = context();
  const [scheme, signer, coordinates, isRevoked] = await Promise.all([
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "authenticatorScheme" }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "authenticator" }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "authenticatorP256" }),
    client().readContract({ address: agent, abi: agentAccountAbi, functionName: "authenticationRevoked" }),
  ]);
  if (scheme !== 1 && scheme !== 2) throw new Error("Unsupported operating key scheme.");
  currentKey = scheme === 2
    ? { scheme: "p256", qx: coordinates[0], qy: coordinates[1] }
    : { scheme: "secp256k1", address: signer };
  revoked = isRevoked; renderSigner();
}
async function changeSigner(operation: "rotateAuthenticator" | "restoreAuthenticator" | "revokeAuthenticator"): Promise<void> {
  const { owner, agent } = context();
  await assertChain();
  if (operation === "revokeAuthenticator" && !window.confirm("Revoke this operating key? New agent signatures will fail until you restore a key.")) return;
  if (operation !== "revokeAuthenticator" && !replacementKeyValid()) throw new Error("Enter a valid new public key for this account's operating key type.");
  status("Confirm the signer change in your owner wallet…");
  let hash: Hex;
  if (operation === "revokeAuthenticator") {
    hash = await wallet().writeContract({ account: owner, chain: null, address: agent, abi: agentAccountAbi, functionName: operation });
  } else if (currentKey?.scheme === "p256") {
    const args = [ui.replacementQx.value.trim() as Hex, ui.replacementQy.value.trim() as Hex] as const;
    hash = operation === "rotateAuthenticator"
      ? await wallet().writeContract({ account: owner, chain: null, address: agent, abi: agentAccountAbi, functionName: "rotateP256Authenticator", args })
      : await wallet().writeContract({ account: owner, chain: null, address: agent, abi: agentAccountAbi, functionName: "restoreP256Authenticator", args });
  } else {
    const args = [getAddress(ui.replacement.value.trim())] as const;
    hash = operation === "rotateAuthenticator"
      ? await wallet().writeContract({ account: owner, chain: null, address: agent, abi: agentAccountAbi, functionName: "rotateAuthenticator", args })
      : await wallet().writeContract({ account: owner, chain: null, address: agent, abi: agentAccountAbi, functionName: "restoreAuthenticator", args });
  }
  status(`Transaction ${short(hash)} submitted. Waiting for confirmation…`);
  const receipt = await client().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The signer transaction reverted. Nothing changed.");
  ui.replacement.value = "";
  ui.replacementQx.value = ""; ui.replacementQy.value = "";
  await refreshSigner();
  status(revoked ? "Operating signer revoked. New agent signatures will fail." : `Operating signer active: ${currentKey ? keyLabel(currentKey) : "unknown"}.`);
}
async function savePolicy(): Promise<void> {
  const { owner, agent } = context();
  await assertChain();
  const encoded = encodeDraft();
  if (same(encoded, currentPolicy)) throw new Error("This draft already matches the onchain policy.");
  status("Confirm the policy transaction in your owner wallet…");
  const hash = await wallet().writeContract({ account: owner, chain: null, address: agent,
    abi: agentPolicyAbi, functionName: "setPolicy", args: [encoded] });
  status(`Policy transaction ${short(hash)} submitted. Waiting for confirmation…`);
  const receipt = await client().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Policy transaction reverted. No changes were saved.");
  const saved = await client().readContract({ address: agent, abi: agentPolicyAbi, functionName: "policy" });
  if (!same(saved, encoded)) throw new Error("Saved policy differs from the draft. Reload the account and inspect it.");
  currentPolicy = saved; savedRules = decodePolicy(saved);
  ui.summaryPolicy.textContent = `${savedRules.length} saved ${savedRules.length === 1 ? "rule" : "rules"}`;
  tag(ui.policyState, "Onchain policy", "ready");
  refresh();
  status(`Policy saved onchain. Hash ${keccak256(saved)}.`);
}
async function preview(amount: string): Promise<void> {
  const { agent } = context();
  await assertChain();
  const rule = savedRules.find(item => !same(item.token, zeroAddress));
  if (!rule) throw new Error("Save a token-purchase rule first.");
  const decimals = await client().readContract({ address: rule.token, abi: tokenMetadataAbi, functionName: "decimals" });
  const data = encodeFunctionData({ abi: purchaseAbi, functionName: "purchaseCompute", args: [rule.token, parseUnits(amount, decimals)] });
  const decision = await client().readContract({ address: agent, abi: agentPolicyAbi, functionName: "evaluateAction", args: [rule.target, 0n, data] });
  const label = decision === Decision.ALLOW ? "ALLOW" : decision === Decision.REQUIRE_OWNER_SIGNATURE ? "OWNER SIGNATURE REQUIRED" : "DENY";
  ui.previewResult.textContent = `${amount} tokens → ${label}. This previews the saved policy, not your unsaved draft.`;
}

ui.salt.value = newSalt();
ui.refreshManaged.addEventListener("click", () => { void refreshManaged().catch(error => status(readableError(error), "error")); });
void refreshManaged().catch(error => status(readableError(error), "error"));
ui.connect.addEventListener("click", () => { void action(connect); });
ui.newSalt.addEventListener("click", () => { ui.salt.value = newSalt(); void action(updatePrediction); });
ui.salt.addEventListener("input", () => { void updatePrediction().catch(error => status(readableError(error), "error")); });
ui.authenticator.addEventListener("input", refresh);
ui.creationScheme.addEventListener("change", refresh);
ui.creationQx.addEventListener("input", refresh);
ui.creationQy.addEventListener("input", refresh);
ui.agent.addEventListener("input", refresh);
ui.replacement.addEventListener("input", refresh);
ui.replacementQx.addEventListener("input", refresh);
ui.replacementQy.addEventListener("input", refresh);
ui.create.addEventListener("click", () => { void action(createAgent); });
ui.verify.addEventListener("click", () => { void action(() => verifyAgent()); });
ui.rotate.addEventListener("click", () => { void action(() => changeSigner("rotateAuthenticator")); });
ui.restore.addEventListener("click", () => { void action(() => changeSigner("restoreAuthenticator")); });
ui.revoke.addEventListener("click", () => { void action(() => changeSigner("revokeAuthenticator")); });
ui.addNative.addEventListener("click", () => { draftRules.push(makeRule("native")); renderRules(); });
ui.addToken.addEventListener("click", () => { draftRules.push(makeRule("token")); renderRules(); });
ui.savePolicy.addEventListener("click", () => { void action(savePolicy); });
ui.previewSmall.addEventListener("click", () => { void action(() => preview("2")); });
ui.previewLarge.addEventListener("click", () => { void action(() => preview("20")); });
renderRules();
