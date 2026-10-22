-- A real request: "Teacher portal should be called co-op teacher
-- portal." db/bootstrapPg.js's own PORTAL_ROLES seed only INSERTs a
-- role row the first time (never updates an existing one's label), so
-- an already-bootstrapped database needs this one-time UPDATE to pick
-- up the new label, same as the earlier update_role_descriptions
-- migration.
UPDATE roles SET label = 'Co-op Teacher' WHERE key = 'teacher';
