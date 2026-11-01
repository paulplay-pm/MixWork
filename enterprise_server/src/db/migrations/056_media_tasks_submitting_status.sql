-- Migration 056: media_tasks.status gains 'submitting'.
--
-- The generate route used to insert the task as 'queued' and only AFTER
-- `provider.submit()` returned did it write the upstream task id. The worker's
-- claim query takes 'queued' rows, so in that window — one upstream round
-- trip — the worker claimed a task that had no upstream id yet and failed it
-- with "no upstream task id". Two things went wrong from that:
--
--   1. The route's later UPDATE set the status back to 'succeeded'/'queued'
--      but left the `error` column alone, so a task that SUCCEEDED still
--      reported an error, and the desktop surfaced it.
--   2. When the worker's failure landed AFTER the route's UPDATE, the task
--      was 'failed' while the upstream render was still running — and the
--      worker only ever polls 'queued' rows, so that video was never
--      collected again.
--
-- 'submitting' is a status the worker does NOT claim. The row is only handed
-- to the worker once the submit has returned and the upstream id is stored.
--
-- 054 created the table with a CHECK on `status`, and the migration ledger
-- keys on the file NAME, so this has to be a NEW file: editing 054 would
-- change nothing on any database that already applied it.
--
-- Re-run safe: DROP IF EXISTS + ADD CONSTRAINT throughout.

ALTER TABLE media_tasks DROP CONSTRAINT IF EXISTS media_tasks_status_check;

ALTER TABLE media_tasks
  ADD CONSTRAINT media_tasks_status_check
  CHECK (status IN ('queued', 'submitting', 'running', 'succeeded', 'failed', 'cancelled'));
