-- Add nextSteps column to epics for tracking what the lead plans to do next
ALTER TABLE epics ADD COLUMN nextSteps TEXT;
