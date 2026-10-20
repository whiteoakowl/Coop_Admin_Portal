-- A real request: "Add description under each portal title. On choose
-- portal page..." with the user's own exact wording per portal. roles.
-- description already existed and was already selected (utils/
-- portalAuth.js's rolesForAccount) but had never been rendered on
-- views/portal-switcher.ejs - db/bootstrapPg.js's own PORTAL_ROLES seed
-- only INSERTs a role row the first time (never updates an existing
-- one's description), so an already-bootstrapped database needs this
-- one-time UPDATE to pick up the new wording.
UPDATE roles SET description = 'Class registration, event registration, family homeschool management, etc.' WHERE key = 'parent';
UPDATE roles SET description = 'View and complete lessons, chat with friends. Challenges, play games etc.' WHERE key = 'student';
UPDATE roles SET description = 'Attendance, manage classes. Lesson plans. Etc.' WHERE key = 'teacher';
UPDATE roles SET description = 'Co-op classes, schedules, floaters, name tags, attendance etc.' WHERE key = 'coop_admin';
UPDATE roles SET description = 'Group management, events, chat groups, approvals, website settings etc.' WHERE key = 'main_admin';
