CREATE TABLE `review_projections` (
	`user_id` text NOT NULL,
	`item_kind` text NOT NULL,
	`item_key` text NOT NULL,
	`fsrs_json` text NOT NULL,
	`due_at` text NOT NULL,
	`scheduler_version` text NOT NULL,
	`applied_event_count` integer NOT NULL,
	`event_set_hash` text NOT NULL,
	`last_reviewed_at` text,
	`source` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `item_kind`, `item_key`),
	FOREIGN KEY (`user_id`) REFERENCES `learning_accounts`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_projections_due_idx` ON `review_projections` (`user_id`,`due_at`);--> statement-breakpoint
CREATE TABLE `study_events_v3` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`core_hash` text NOT NULL,
	`schema_version` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`domain` text NOT NULL,
	`event_type` text NOT NULL,
	`item_kind` text NOT NULL,
	`item_key` text NOT NULL,
	`state_handle` text,
	`rating` text,
	`correct` integer,
	`stage_before` integer,
	`stage_after` integer,
	`reviewed_at` text,
	`scheduler_version` text,
	`client_projection_json` text,
	`baseline_json` text,
	`received_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `learning_accounts`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `study_events_v3_user_event_uq` ON `study_events_v3` (`user_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `study_events_v3_replay_idx` ON `study_events_v3` (`user_id`,`item_kind`,`item_key`,`reviewed_at`,`event_id`);--> statement-breakpoint
CREATE INDEX `study_events_v3_cursor_idx` ON `study_events_v3` (`user_id`,`sequence`);