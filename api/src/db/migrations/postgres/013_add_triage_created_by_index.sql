-- Add missing index on triage_tickets.created_by for faster lookups
-- when filtering tickets by creator (regular user view, duplicate detection).
CREATE INDEX IF NOT EXISTS idx_triage_tickets_created_by
  ON triage_tickets(created_by, status);
