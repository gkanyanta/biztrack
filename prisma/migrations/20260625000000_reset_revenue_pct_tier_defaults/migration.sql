-- Reset per_unit migration defaults (50 / 30) for revenue_pct consultants.
-- The 20260413010000 migration added tierThreshold DEFAULT 50 and tierRate DEFAULT 30
-- with per_unit semantics in mind. Any consultant with payType='revenue_pct' that still
-- carries those exact defaults never had their tier intentionally configured (the UI
-- was not deployed). Setting them to 0 puts them into flat-rate mode so no accidental
-- 30%-on-everything commission fires. Admin can then set real tier values via the UI.
UPDATE "Consultant"
SET "tierThreshold" = 0, "tierRate" = 0
WHERE "payType" = 'revenue_pct'
  AND "tierThreshold" = 50
  AND "tierRate" = 30;
