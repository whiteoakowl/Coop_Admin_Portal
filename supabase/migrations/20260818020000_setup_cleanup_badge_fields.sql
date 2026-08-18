-- Real bug report: "Setup/cleanup task cards are a mess... The only
-- information that should be included on each setup/cleanup badge is
-- day, team name, leader, task and the barcode." The badge previously
-- showed a big scannable badge_number plus title=task text/
-- description=task-list-section title, with no shrink-to-fit sizing -
-- overlapping text on anything longer than a short task. Redesigning the
-- badge to the requested 5 fields repurposes misc_badges' existing
-- title/description columns for setupCleanup rows (title -> team name,
-- description -> task text, swapped from their old meaning) and adds the
-- two genuinely new fields, day and leader_name - both nullable, and
-- both always null for 'custom' rows (that badge type keeps its own
-- generic title/description shape, untouched by this).
alter table misc_badges add column if not exists day text;
alter table misc_badges add column if not exists leader_name text;
