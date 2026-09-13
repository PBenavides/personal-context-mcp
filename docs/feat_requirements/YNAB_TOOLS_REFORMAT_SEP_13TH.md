## On YNAB Tools reformat (made on September 13th)

The current 8-tool YNAB surface is a read-mostly port of the Python server: seven
pulls and a single write (`ynab_create_transaction`) that speaks raw milliunits and
has no dry_run. That shape does not serve what the surface is actually for now:
**agents that run scheduled or on a hook** — a triage agent woken when a
transaction puts a category at risk, and a weekly steering agent reporting savings
progress and budget alignment — plus a human-in-the-loop flow where the AI
*proposes* budget changes and a person approves them. Creating transactions is the
least interesting write; **allocating money to categories** (the one-month-ahead
method: this month's income funds next month's categories) is the primary one.

Constraint set: the official OpenAPI spec v1.86.0 (https://api.ynab.com/papi/open_api_spec.yaml).
Facts that shape the design:

- YNAB renamed budgets→plans in v1.79.0 (2026-03); `/budgets/...` paths still work
  but are no longer documented. This reformat moves the client to `/plans/...`
  (tool params keep the familiar `budget_id` name; `last-used` still works).
- Assigning is `PATCH /plans/{id}/months/{month}/categories/{cid}` with an absolute
  `budgeted` milliunit amount; month is `current` or ISO first-of-month, and future
  months (the month-ahead motion) are patchable.
- The API grew real write surface in 2026: category create/update (incl. targets),
  category groups, payee create/rename, scheduled-transaction CRUD. Still
  impossible: deleting categories/accounts/payees, creating a whole plan, editing
  splits after creation, direct "move money" records (emulated as two PATCHes).
- Month detail carries everything a steering agent needs: `to_be_budgeted` (Ready
  to Assign), `age_of_money`, and per-category `budgeted/activity/balance` plus
  `goal_under_funded` (the app's Underfunded number). One-month-ahead semantics:
  when assigning into the future, the *future-most* month's RTA is authoritative
  (current month reads 0 while you're ahead).
- Rate limit is 200 req/hour — scheduled agents must answer in 1–3 calls, so reads
  are pre-shaped for the question, not the endpoint.

´´´ynab_current_tools
Read operations:
1. List YNAB budgets: ynab_budgets
2. List YNAB accounts: ynab_accounts
3. Query YNAB transactions: ynab_transactions
4. List YNAB categories: ynab_categories
5. List YNAB payees: ynab_payees
6. List YNAB scheduled transactions: ynab_scheduled
7. YNAB financial report: ynab_report

Write operations:
8. Create YNAB transaction: ynab_create_transaction
   (milliunits, no dry_run, no update/delete, no annotations)
´´´

Where they're defined
- src/mcps/personal-tools/index.ts — registration (lines 93–329), INSTRUCTIONS (37–53)
- src/mcps/personal-tools/tools.ts — handlers (lines 36–349)
- src/connections/ynab.ts — GET/POST only; write verbs must be added

## Required Edits on the Tools layer:

### Cross-cutting rules (all tools)

1. **Currency units everywhere; milliunits never leak.** Every read converts
   `x/1000`. Every write accepts human amounts — number (`250.5`) or string
   (`"$250.50"`, `"250,50 EUR"`, `"-$45"`) — parsed to milliunits internally.
   Parser rule: strip one leading/trailing currency symbol or 3-letter code; if
   both `.` and `,` appear the last one is the decimal separator; a lone separator
   followed by exactly 2 digits is decimal, by 3 is thousands. Ambiguous input is
   refused with the accepted formats named. Outflow = negative, inflow = positive.
2. **Names are first-class ids.** category/account/payee params accept a name or a
   uuid. Resolution is case-insensitive exact-then-substring; zero matches or >1
   matches are refused with the candidates listed, never guessed.
3. **Months accept `current` (default), `next`, `YYYY-MM`, or `YYYY-MM-01`.**
   `next` is the one-month-ahead target and is computed server-side.
4. **All writes take `dry_run`** returning `{dry_run, method, endpoint, payload}`
   after the full build path (resolution + validation) has run — a dry run is a
   real rehearsal and the AI→human proposal artifact. Reads keep
   `readOnlyHint: true`; writes carry explicit annotations.
5. **Errors name the fix**, Hevy-style. Pure builders live in a new
   `ynab-payloads.ts` (no I/O) so payload rules unit-test directly.

### New surface — 8 tools (5 read, 3 write)

**(A) ynab_overview — NEW read; the agent's first call.**
Input: budget_id?, month? (default current).
Fetches month detail + the following month + scheduled transactions (3 GETs) and
answers in one shot: ready_to_assign for this and next month (with the
future-most-is-authoritative note), age_of_money, income/assigned/activity,
month_ahead progress (next month's underfunded categories via goal_under_funded,
fully_funded flag), overspent categories, upcoming scheduled bills (30 days), and
a derived `alerts` list (overspending, over-assigned future RTA < 0, underfunded
next month). Draft shape (rough idea only):
´´´json
{
  "month": "2026-09",
  "ready_to_assign": { "this_month": 0, "next_month": 420.5 },
  "age_of_money": 34,
  "income": 3200, "assigned": 3100, "activity": -1850,
  "month_ahead": {
    "fully_funded": false,
    "underfunded_total": 120,
    "underfunded": [ { "category": "Groceries", "needed": 120 } ]
  },
  "overspent": [ { "category": "Dining Out", "overspent_by": 45.25 } ],
  "upcoming_scheduled": [ { "date": "2026-09-15", "payee": "Landlord", "amount": -1200, "category": "Rent" } ],
  "alerts": [ "Dining Out is overspent by 45.25 — cover it before assigning ahead" ]
}
´´´

**(B) ynab_transactions — kept, improved.** Adds until_date, limit (default 30,
newest first), category/payee by name-or-id; compact view in currency units.
Budget-wide listing still requires since_date. verbose=true returns raw objects.

**(C) ynab_categories — reshaped.** List mode: compact groups → categories with
{id, name, assigned, activity, available, target {type, target, under_funded,
pct}} for a month; hidden/deleted skipped unless include_hidden. Detail mode
(category by name/id): full goal fields, month-scoped.

**(D) ynab_report — kept as is** (net_worth | monthly_summary | full), already in
currency units.

**(E) ynab_lookup — NEW; folds tools (1)(2)(5)(6).** entity:
budgets | accounts | payees | scheduled, optional id, compact projections
(accounts include transfer_payee_id for transfers; closed/deleted filtered unless
include_closed). No combination of entity and unrelated filters is allowed.

**(F) ynab_assign — NEW write; the centerpiece.**
Input: budget_id?, month? (default current; `next` for the month-ahead motion),
assignments: [{category, set? | adjust?}] (exactly one of set/adjust per item),
dry_run?. Reads the month once, resolves names, computes before→after per
category (set = absolute, adjust = ±delta; a move is one category down + another
up in the same call), then PATCHes each category. Returns
{month, changes: [{category, before, after}], ready_to_assign_projected}.
dry_run previews exactly that without writing.

**(G) ynab_write_transaction — replaces tool (8); id decides the verb.**
Create (no transaction_id): account (name/id) + date + amount required; payee,
category (name/id), memo, cleared, approved, flag_color, import_id (dedup),
splits[]. Update (transaction_id): only supplied fields change (API semantics —
no merge needed). delete: true deletes. A future date or a `frequency` value
routes to the scheduled-transaction endpoints automatically (splits refused
there; result notes `routed_to: "scheduled"`; scheduled=true targets scheduled
records for update/delete). Splits cannot be edited after creation (API limit) —
the error says delete + recreate.

**(H) ynab_write_category — NEW write; the "priorities changed" tool.**
Create category (name + group), rename/move/note an existing one (category by
name/id), set/change/remove targets (target_amount human format, target_date,
target_frequency monthly|weekly|yearly, remove_target), create a category group
(new_group), rename one (group + rename_group_to). Cannot delete or hide —
refused with "archive it in the app".

### Retired
ynab_budgets, ynab_accounts, ynab_payees, ynab_scheduled → ynab_lookup.
ynab_create_transaction → ynab_write_transaction.

### Also updated
- src/connections/ynab.ts gains put/patch/delete (model: hevy.ts) and moves to /plans paths.
- INSTRUCTIONS in index.ts rewritten: units convention, overview-first guidance,
  one-month-ahead workflow (assign income to month="next" until RTA is 0),
  dry_run contract, API impossibilities.
- docs/personal-tools.md YNAB section, README.md, AGENTS.md tool names.
