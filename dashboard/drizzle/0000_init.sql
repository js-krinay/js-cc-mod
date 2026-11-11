CREATE TABLE `files` (
	`name` text PRIMARY KEY NOT NULL,
	`offset` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `peers` (
	`url` text PRIMARY KEY NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prices` (
	`price_key` text PRIMARY KEY NOT NULL,
	`input` real,
	`w5` real,
	`w1` real,
	`rd` real,
	`out` real,
	`over` real,
	`l_input` real,
	`l_w5` real,
	`l_w1` real,
	`l_rd` real,
	`l_out` real
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`uid` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`price_key` text,
	`ended_at` real,
	`duration_ms` real,
	`first_chunk_ms` real,
	`machine` text,
	`user` text,
	`session_id` text,
	`session_title` text,
	`cwd` text,
	`branch` text,
	`source` text,
	`turn_id` text,
	`step` real,
	`agent_id` text,
	`agent_type` text,
	`agent_description` text,
	`model` text,
	`model_answered` text,
	`effort` text,
	`stop_reason` text,
	`input_tokens` real,
	`output_tokens` real,
	`cache_read_tokens` real,
	`cache_write_tokens` real,
	`tools` real,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `requests_ended_at` ON `requests` (`ended_at`);--> statement-breakpoint
CREATE INDEX `requests_origin` ON `requests` (`origin`);