# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web.mobile.spec.ts >> web · mobile (touch) >> onboarding + bottom navigation (needs API)
- Location: e2e/web.mobile.spec.ts:19:3

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.tap: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByTestId('faction-confirm')
    - waiting for "http://localhost:5173/onboarding/faction" navigation to finish...
    - navigated to "http://localhost:5173/onboarding/faction"
    - locator resolved to <button disabled type="button" data-testid="faction-confirm" class="nf-btn nf-btn--primary nf-btn--lg">…</button>
  - attempting tap action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying tap action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying tap action
      - waiting 100ms
    50 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying tap action
       - waiting 500ms

```

# Page snapshot

```yaml
- generic [ref=f1e3]:
  - navigation "Onboarding progress" [ref=f1e4]:
    - generic [ref=f1e10]: "2"
    - generic [ref=f1e14]: "3"
    - generic [ref=f1e18]: "4"
  - banner [ref=f1e22]:
    - generic [ref=f1e23]: Allegiance
    - heading "Choose your faction" [level=1] [ref=f1e24]
    - paragraph [ref=f1e25]: Your faction sets your home sector, starter ship and faction bonuses. This choice is permanent for this pilot.
  - radiogroup "Factions" [ref=f1e26]:
    - radio "AURORA INDUSTRIES “Light the way.” Born from the solar-sail shipyards that first ringed the Lyra Dawn star, Aurora Industries grew into the frontier's largest builder of civilian and survey craft. Its engineers believe that every dark lane can be charted and every derelict repaired. When the Rift began swallowing trade routes, Aurora armed its survey fleets rather than abandon the colonies that depend on them. +3% Shield Regen +2% Speed Starter ship Lumen · Interceptor Home Aurora Prime Pilots 165 Tag [AUR]" [ref=f1e27] [cursor=pointer]:
      - generic [ref=f1e37]:
        - generic [ref=f1e38]:
          - generic [ref=f1e39]: AURORA INDUSTRIES
          - generic [ref=f1e40]: “Light the way.”
        - paragraph [ref=f1e41]: Born from the solar-sail shipyards that first ringed the Lyra Dawn star, Aurora Industries grew into the frontier's largest builder of civilian and survey craft. Its engineers believe that every dark lane can be charted and every derelict repaired. When the Rift began swallowing trade routes, Aurora armed its survey fleets rather than abandon the colonies that depend on them.
        - generic [ref=f1e42]:
          - generic [ref=f1e43]: +3% Shield Regen
          - generic [ref=f1e44]: +2% Speed
        - generic [ref=f1e45]:
          - generic [ref=f1e46]:
            - term [ref=f1e47]: Starter ship
            - definition [ref=f1e48]:
              - text: Lumen
              - generic [ref=f1e49]: · Interceptor
          - generic [ref=f1e50]:
            - term [ref=f1e51]: Home
            - definition [ref=f1e52]: Aurora Prime
          - generic [ref=f1e53]:
            - term [ref=f1e54]: Pilots
            - definition [ref=f1e55]: "165"
          - generic [ref=f1e56]:
            - term [ref=f1e57]: Tag
            - definition [ref=f1e58]: "[AUR]"
    - radio "VORTEX CONSORTIUM “Everything has a price. We set it.” The Vortex Consortium is a merger of a hundred salvage guilds, freight lines and mercenary charters bound by a single ledger. Its gunships escort the ore convoys of the Titan Expanse, and its brokers own half the docks between. The Consortium fights for contracts, not ideals, and it always collects. +3% Hull +5% Cargo Starter ship Gale · Assault Home Vortex Haven Pilots 48 Tag [VTX]" [ref=f1e59] [cursor=pointer]:
      - generic [ref=f1e69]:
        - generic [ref=f1e70]:
          - generic [ref=f1e71]: VORTEX CONSORTIUM
          - generic [ref=f1e72]: “Everything has a price. We set it.”
        - paragraph [ref=f1e73]: The Vortex Consortium is a merger of a hundred salvage guilds, freight lines and mercenary charters bound by a single ledger. Its gunships escort the ore convoys of the Titan Expanse, and its brokers own half the docks between. The Consortium fights for contracts, not ideals, and it always collects.
        - generic [ref=f1e74]:
          - generic [ref=f1e75]: +3% Hull
          - generic [ref=f1e76]: +5% Cargo
        - generic [ref=f1e77]:
          - generic [ref=f1e78]:
            - term [ref=f1e79]: Starter ship
            - definition [ref=f1e80]:
              - text: Gale
              - generic [ref=f1e81]: · Assault
          - generic [ref=f1e82]:
            - term [ref=f1e83]: Home
            - definition [ref=f1e84]: Vortex Haven
          - generic [ref=f1e85]:
            - term [ref=f1e86]: Pilots
            - definition [ref=f1e87]: "48"
          - generic [ref=f1e88]:
            - term [ref=f1e89]: Tag
            - definition [ref=f1e90]: "[VTX]"
    - 'radio "NOVA DYNASTY “Burn bright. Burn forever.” The Nova Dynasty traces its line to the colonists who survived the collapse of the Crown star by riding its shockwave outward. Their houses rule by lineage and duel, and their warships are forged as heirlooms. The Dynasty sees the Void Frontier as an ancestral trial: whoever tames it will earn the right to rekindle the Crown. +2% Damage +1% Crit Chance Starter ship Ember · Striker Home Nova Crown Pilots 55 Tag [NOV]" [ref=f1e91] [cursor=pointer]':
      - generic [ref=f1e101]:
        - generic [ref=f1e102]:
          - generic [ref=f1e103]: NOVA DYNASTY
          - generic [ref=f1e104]: “Burn bright. Burn forever.”
        - paragraph [ref=f1e105]: "The Nova Dynasty traces its line to the colonists who survived the collapse of the Crown star by riding its shockwave outward. Their houses rule by lineage and duel, and their warships are forged as heirlooms. The Dynasty sees the Void Frontier as an ancestral trial: whoever tames it will earn the right to rekindle the Crown."
        - generic [ref=f1e106]:
          - generic [ref=f1e107]: +2% Damage
          - generic [ref=f1e108]: +1% Crit Chance
        - generic [ref=f1e109]:
          - generic [ref=f1e110]:
            - term [ref=f1e111]: Starter ship
            - definition [ref=f1e112]:
              - text: Ember
              - generic [ref=f1e113]: · Striker
          - generic [ref=f1e114]:
            - term [ref=f1e115]: Home
            - definition [ref=f1e116]: Nova Crown
          - generic [ref=f1e117]:
            - term [ref=f1e118]: Pilots
            - definition [ref=f1e119]: "55"
          - generic [ref=f1e120]:
            - term [ref=f1e121]: Tag
            - definition [ref=f1e122]: "[NOV]"
  - generic [ref=f1e124]:
    - generic [ref=f1e125]: Select a faction
    - button "Confirm" [disabled] [ref=f1e126]
```

# Test source

```ts
  1  | import { expect, test } from "@playwright/test";
  2  | import { apiUp, registerThroughUi, shot } from "./helpers.js";
  3  | 
  4  | test.describe("web · mobile (touch)", () => {
  5  |   test("landing is touch-friendly and fits the viewport", async ({ page }) => {
  6  |     await page.goto("/");
  7  |     await expect(page.getByTestId("cta-enter")).toBeVisible();
  8  |     const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  9  |     expect(overflow).toBeLessThanOrEqual(1);
  10 |     await shot(page, "mobile-landing");
  11 |   });
  12 | 
  13 |   test("login renders on small screens", async ({ page }) => {
  14 |     await page.goto("/login");
  15 |     await expect(page.getByTestId("wallet-signin")).toBeVisible();
  16 |     await shot(page, "mobile-login");
  17 |   });
  18 | 
  19 |   test("onboarding + bottom navigation (needs API)", async ({ page, request }) => {
  20 |     test.skip(!(await apiUp(request)), "API not reachable — skipping authenticated flow");
  21 |     await registerThroughUi(page);
  22 |     await page.getByTestId("faction-nova").tap();
  23 |     await shot(page, "mobile-faction-select");
> 24 |     await page.getByTestId("faction-confirm").tap();
     |                                               ^ Error: locator.tap: Test timeout of 60000ms exceeded.
  25 |     await page.getByTestId("faction-pledge").tap();
  26 |     await page.waitForURL(/\/onboarding\/ship/);
  27 |     await page.getByRole("button", { name: /command deck/i }).tap();
  28 |     await page.waitForURL(/\/home/);
  29 |     const nav = page.getByRole("navigation", { name: "Primary" });
  30 |     await expect(nav).toBeVisible();
  31 |     for (const label of ["Home", "Hangar", "Galaxy", "Clan", "Shop", "Wallet"]) await expect(nav.getByText(label)).toBeVisible();
  32 |     await shot(page, "mobile-home");
  33 |     await nav.getByText("Hangar").tap();
  34 |     await page.waitForURL(/\/hangar/);
  35 |     await shot(page, "mobile-hangar");
  36 |     await nav.getByText("Wallet").tap();
  37 |     await page.waitForURL(/\/wallet/);
  38 |     await shot(page, "mobile-wallet");
  39 |   });
  40 | });
  41 | 
```