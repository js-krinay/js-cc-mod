ALTER TABLE `requests` ADD `tool_names` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `server_tools` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `message_count` real;--> statement-breakpoint
ALTER TABLE `requests` ADD `engine_version` text;--> statement-breakpoint
-- The index is derived: clearing it makes the next start read every log file
-- (and every peer) again, so rows written before these columns get them too.
DELETE FROM `requests`;--> statement-breakpoint
DELETE FROM `files`;--> statement-breakpoint
DELETE FROM `peers`;
