# Nozzle Catalog — Sources

Reference sources used to compile `nozzles_seed.sql` (Wilton, Ateco, PME).
Reliability legend: ✅ fully fetched/parsed · ◐ search snippet or partial · ⛔ blocked (CAPTCHA/403/TLS).

## Primary (most authoritative)

| # | Source | URL | Gave | Reliability |
|---|--------|-----|------|-------------|
| 1 | Pastry Sampler — Tip Conversion Chart | https://www.pastrysampler.com/Articles/Tip_Conversions.htm | Cross-brand equivalents: Ateco/Wilton/Magic Line — round 800s, open star 820s, French 860s, petal/leaf/drop-flower | ✅ |
| 2 | Kowanii — Piping Tips Chart Guide | https://www.kowanii.com/blogs/news/piping-tips-chart-guide-a-comprehensive-guide-for-cake-decorating | Numbers grouped by category (round, star, petal, leaf, drop flower, basketweave, grass) | ✅ |
| 3 | Wilton — Master Cake Decorating Piping Tips Set (55-pc) | https://wilton.com/master-cake-decorating-piping-tips-set-55-piece-cake-and-cupcake-decorating-set/191001557/ | Wilton numbers by category | ◐ |
| 4 | Wilton — Deluxe Decorating Tip Set (29-pc) | https://wilton.com/deluxe-decorating-tip-set-29-piece/191001671/ | Wilton numbers by category | ◐ |

## Wilton — usage / category guides

| # | Source | URL | Gave | Reliability |
|---|--------|-----|------|-------------|
| 5 | Wilton blog — How To Use A Star Piping Tip | https://blog.wilton.com/how-to-use-a-star-piping-tip-star-tip-cake-decorating-and-more/ | Open vs closed star behavior | ◐ |
| 6 | Wilton blog — How to Use Petal Piping Tips (101 guide) | https://blog.wilton.com/how-to-use-petal-piping-tips-101-guide/ | Petal/rose tip uses | ◐ |
| 7 | Wilton — Piping Tips 101 starter guide | https://wilton.com/baking-inspiration/piping-tips-101-starter-guide/ | Category overview | ◐ |
| 8 | Bakestarters — 10 Must-Have Wilton Piping Tips | https://bakestarters.com/blogs/education/10-must-have-wilton-piping-tips | The go-to tips (informed `is_common`) | ◐ |
| 9 | CakeCentral — Decorating Tip Numbers | https://www.cakecentral.com/tutorial/20193/decorating-tip-numbers | Category headings (numbers were in images only) | ◐ |
| 10 | CakeCentral — List Of Wilton Cake Decorating Tips | https://www.cakecentral.com/forum/t/603945/list-of-wilton-cake-decorating-tips | Wilton number list | ◐ |

## Ateco

| # | Source | URL | Gave | Reliability |
|---|--------|-----|------|-------------|
| 11 | Sweet Treat Supply — Wilton & Ateco tips | https://www.sweettreatsupply.com/piping-tips-s/1943.htm | Ateco series confirmation | ◐ |
| 12 | WebstaurantStore — Ateco piping tip compatibility guide (PDF) | https://www.webstaurantstore.com/documents/PDF/compatibility/ateco-piping_tip_compatibility-guide.pdf | Ateco compatibility/series | ◐ |
| 13 | Scribd — Ateco Piping Tips Size Chart | https://www.scribd.com/document/470920505/ateco-piping-tip-compatibility-guide | Ateco size chart | ◐ |

## PME (several pages CAPTCHA/403-walled — verify directly)

| # | Source | URL | Gave | Reliability |
|---|--------|-----|------|-------------|
| 14 | PME — SupaTubes (official) | https://www.pmecake.com/en-gb/essentials/piping/piping-tubes/ | Canonical PME SupaTube numbers/names | ⛔ (verify directly — canonical) |
| 15 | PME — SupaTube No.1 Writer (example product) | https://www.pmecake.com/en-gb/essentials/piping/piping-tubes/PME-Supatubes-No-1-Writer/ | Writer #1 use | ◐ |
| 16 | PME — SupaTube No.6 Medium Star (example product) | https://www.pmecake.com/en-gb/essentials/piping/piping-tubes/PME-Supatubes-No-6-Medium-Star/ | Confirmed medium star = #6 | ◐ |
| 17 | Cake-Stuff — PME Piping Tips | https://www.cake-stuff.com/equipment-c3/piping-tips-c67/pme-m8 | PME range listing | ⛔ (403) |
| 18 | Sugar & Crumbs — PME SupaTube Set of 12 | https://www.sugarandcrumbs.co.uk/product/pme-supatube-set-of-12/ | Confirmed set numbers: 1, 1.5, 2, 3, 4, 7, 13, 17, 44, 52, 53, 57S | ◐ |
| 19 | The Cookie Countess — PME SupaTube tips | https://www.thecookiecountess.com/products/pme-supatube-1-tip | Writer sizes (00, 0, 1, 1.5, 2, 2.5, 3, 4) | ◐ |
| 20 | CK Products — PME SupaTube Writer #2.5 | https://www.ckproducts.com/tools/decorating-tools/pme-supatube-decorating-tip-writer-11-2-5-43--st2.5 | Half-size writers | ◐ |

## Best places to expand the catalog further

- **Cross-brand equivalents:** Pastry Sampler chart (#1).
- **PME full range:** pmecake.com SupaTubes (#14) — canonical, grab directly (was CAPTCHA-walled for automated fetch).
- **Wilton full poster:** Wilton's official "Decorate Smart" tip poster / yearbook (numbers live in images, not text).

## Notes on confidence

- Entries corroborated by a source above, or canonically well-known (e.g. Wilton 1M, 2D, 104, 352), are in the seed.
- Softer / series-inferred entries worth an admin spot-check: PME star **5** / **8**, Ateco closed-star **845** / **848**, Wilton closed-star **30** / **35**.
- A guaranteed-exhaustive (250+) dump was not reachable automatically — several authoritative pages were CAPTCHA/403/TLS-blocked. The seed (121 entries) is conservative-verified; expand via the admin bulk-add screen.
