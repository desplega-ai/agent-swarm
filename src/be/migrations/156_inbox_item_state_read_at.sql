-- Adds a first-viewed timestamp to inbox_item_state, independent of status.
--
-- The notification bell needs to stop counting an item as unread once the
-- user has opened the panel and seen it, without moving the item out of the
-- "open" (un-actioned) bucket -- dismiss/done stay reserved for explicit user
-- actions. readAt is set once on first view and never cleared.
ALTER TABLE inbox_item_state ADD COLUMN readAt TEXT;
