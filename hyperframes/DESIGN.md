# Visual identity — WCAG Audit Agent demo

Derived from the product's own report UI (`src/ui.ts`): a clean, technical, accessibility-tool
aesthetic on a light "paper" canvas with a deep-teal/navy brand and the audit status colors.

## Style Prompt

Calm, precise, document-forward. Light paper background, deep teal + navy ink, generous whitespace,
crisp 1px lines and rounded cards. Status communicated through a restrained pass-green / fail-red /
amber-needs-human system. Motion is measured and confident — content settles into place, checks tick
on in sequence, the human gate resolves with a single decisive stamp. Nothing flashy; it should read
like a trustworthy compliance instrument.

## Colors

- `#eef2f6` — canvas / page background (cool paper)
- `#ffffff` — cards / panels
- `#17324d` — headline ink (navy)
- `#0f4f6f` — brand / accent (deep teal)
- `#1f2430` — body ink
- `#6b7280` — muted text
- `#e7e3da` — hairlines
- `#15803d` on `#dcfce7` — PASS
- `#b42318` on `#fee2e2` — FAIL
- `#b45309` on `#fef3c7` — needs-human / pending
- `#0f2233` — dark control strip (inverse panel)

## Typography

- `Inter Tight` — display / headlines (600–800)
- `Inter` — body, labels, data (400–700), `tabular-nums` on counts

## What NOT to Do

- No neon, no glassmorphism, no full-screen gradients (banding) — solid fills + subtle shadows only.
- No playful bounce/elastic on the audit data — keep status changes deterministic and crisp.
- Don't invent new hues; use only the palette above.
- No jump cuts between scenes — always crossfade.
- Don't let the green "pass" dominate; the story is honesty (fail + needs-human are visible).
