CREATE TABLE `learning_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`timezone` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`sync_mode` text DEFAULT 'balanced' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `learning_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`domain` text NOT NULL,
	`item_kind` text NOT NULL,
	`item_key` text NOT NULL,
	`event_type` text NOT NULL,
	`outcome` text NOT NULL,
	`numeric_value` integer,
	`answered_delta` integer DEFAULT 0 NOT NULL,
	`correct_delta` integer DEFAULT 0 NOT NULL,
	`occurred_at` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `learning_accounts`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_learning_events_user_event` ON `learning_events` (`user_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `idx_learning_events_user_sequence` ON `learning_events` (`user_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `learning_item_states` (
	`user_id` text NOT NULL,
	`item_kind` text NOT NULL,
	`item_key` text NOT NULL,
	`numeric_value` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text,
	PRIMARY KEY(`user_id`, `item_kind`, `item_key`),
	FOREIGN KEY (`user_id`) REFERENCES `learning_accounts`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_learning_item_states_user_kind` ON `learning_item_states` (`user_id`,`item_kind`);--> statement-breakpoint
CREATE TABLE `progress_counters` (
	`user_id` text PRIMARY KEY NOT NULL,
	`answered` integer DEFAULT 0 NOT NULL,
	`correct` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `learning_accounts`(`user_id`) ON UPDATE no action ON DELETE cascade
);
