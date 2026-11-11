ALTER TABLE `requests` ADD `project` text;--> statement-breakpoint
CREATE INDEX `requests_session` ON `requests` (`session_id`,`ended_at`);