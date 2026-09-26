---
name: Agentic World
description: A precise protocol workbench for creating and configuring one agent account.
colors:
  canvas: "#eff4f2"
  surface: "#ffffff"
  ink: "#132d2e"
  muted: "#506768"
  line: "#cbdad7"
  line-strong: "#9fb9b4"
  primary-teal: "#006d66"
  primary-hover: "#005950"
  teal-soft: "#e1f2ee"
  navigation: "#102a2c"
  warning: "#874822"
  warning-soft: "#fff1df"
  danger: "#a33b34"
typography:
  display:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "3.25rem"
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: "-.03em"
  title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "1.43rem"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "16px"
    lineHeight: 1.62
  label:
    fontFamily: "DM Mono, ui-monospace, monospace"
    fontSize: "11px"
rounded:
  control: "7px"
  panel: "10px"
spacing:
  compact: "8px"
  standard: "16px"
  section: "44px"
components:
  button-primary:
    backgroundColor: "{colors.primary-teal}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "6px"
    padding: "9px 11px"
  state-pill:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted}"
    rounded: "99px"
    padding: "6px 9px"
---

# Design System: Agentic World

## 1. Overview

**Creative North Star: "Protocol Workbench"**

A technical operator uses this interface to configure one smart account, likely while testing a hackathon deployment. The page makes chain state, ownership, signer authority, and policy actions inspectable. It is a product tool, not a marketing page: restrained surfaces and familiar controls keep the transaction sequence legible.

The identity is cool and flat: a deep teal navigation bar, pale green-gray canvas, white working surfaces, and one saturated teal action color. It rejects generic SaaS dashboard cards, faux-glass crypto styling, dense wallet jargon without explanation, and decorative graphics that obscure the setup sequence.

**Key Characteristics:**

- A numbered setup flow because order is operationally meaningful.
- Exact addresses and hashes in mono, with plain-language labels beside them.
- Read-only checks and wallet transactions use visibly different action treatments.
- Service resource authorization is explained separately from account execution policy.

## 2. Colors

The restrained palette uses teal only for primary action and confirmed state; warnings and denials have separate named colors and text labels.

### Primary

- **Protocol Teal** (`#006d66`): primary buttons, active connection, and confirmed state.
- **Deep Protocol Teal** (`#005950`): primary-button hover.
- **Teal Wash** (`#e1f2ee`): subtle active or positive state background.

### Neutral

- **Navigation Ink** (`#102a2c`): top bar and trust-boundary panel.
- **Workbench Canvas** (`#eff4f2`): page background.
- **Clean Surface** (`#ffffff`): inputs and working panels.
- **Primary Ink** (`#132d2e`): body text and headings.
- **Secondary Ink** (`#506768`): explanatory copy, never the only indication of state.
- **Structure Lines** (`#cbdad7`, `#9fb9b4`): section and control boundaries.

### Named Rules

**The One Accent Rule.** Keep `#006d66` for actions and confirmed state, not decorative fills. Use the warning (`#874822`) and danger (`#a33b34`) roles only with an explicit status label.

## 3. Typography

**Display Font:** IBM Plex Sans with system-ui fallback.

**Body Font:** IBM Plex Sans with system-ui fallback.
**Label/Mono Font:** DM Mono with ui-monospace fallback.

IBM Plex Sans keeps dense technical forms approachable. DM Mono is reserved for addresses, hashes, compact state labels, and the route diagram; it should never carry long explanatory paragraphs.

### Hierarchy

- **Display** (600, `3.25rem`, 1.12): only the page introduction; `2.2rem` on small screens.
- **Title** (600, `1.43rem`, 1.25): setup-section titles.
- **Body** (400, `16px`, 1.62): introductory explanation, capped near 70 characters per line.
- **Label** (600, `12px`): fields and compact actions; mono labels use `11px`.

**The Data Is Not a Headline Rule.** Addresses and hashes wrap safely in compact mono text; they never determine the page's visual hierarchy.

## 4. Elevation

There are no decorative shadows. Depth comes from a cool canvas, white form surfaces, 1px borders, and the dark navigation/authority boundary. Focus uses a visible 3px outline, not elevation.

**The Flat-By-Default Rule.** Do not combine wide soft shadows with bordered panels. State changes use color and text, not simulated floating layers.

## 5. Components

### Buttons

- **Shape:** 7px corners, 40px minimum height, consistent 13px semibold label.
- **Primary:** `#006d66` with white text; only for create and save transactions.
- **Secondary:** white with a 1px `#9fb9b4` border for read-only checks and low-risk controls.
- **States:** hover changes fill or border in 180ms; keyboard focus is a 3px `#38ac9f` outline; disabled retains its label and reduces opacity.

### State pills

Neutral state uses an outlined pill; ready state adds `#e1f2ee`; danger uses a pale red surface. Every pill includes text such as “Active” or “Revoked”.

### Panels and rule rows

Working panels have 9–10px corners, 1px cool borders, and no shadow. The numbered flow uses horizontal section boundaries. Repeated policy rows are cards only because each row is an editable unit; they do not form a generic metrics grid.

### Inputs

Inputs use white fill, 1px `#a9bfba` border, 6px corners, and minimum 42px height. Labels sit above the control. Placeholder text is readable; validation errors state the exact field or rule to fix.

### Navigation and authority rail

The top bar is `#102a2c`, with the connected network and owner wallet visible. The sticky rail summarizes current onchain state and keeps service authorization visibly separate. On narrow screens, it becomes a non-sticky section after the setup flow.

## 6. Do's and Don'ts

### Do:

- **Do** distinguish read-only verification from owner-wallet transactions through label and button treatment.
- **Do** show exact agent, owner, validator, hook, and EntryPoint addresses after verification.
- **Do** preserve 4.5:1 body contrast, visible keyboard focus, text status, and reduced-motion behavior.
- **Do** keep new setup screens within this single-agent workflow unless the product scope changes.

### Don't:

- **Don't** use generic SaaS dashboard cards or hero metrics.
- **Don't** use faux-glass crypto styling or purple/neon gradients.
- **Don't** introduce dense wallet jargon without explanation near the relevant action.
- **Don't** add decorative graphics that obscure the setup sequence.
- **Don't** imply that onchain execution policy grants service API access.
