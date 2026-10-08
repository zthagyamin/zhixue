CREATE TABLE `account_study_heads` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`snapshot_id` text,
	`revision` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`),
	FOREIGN KEY (`user_id`,`library_id`) REFERENCES `account_study_libraries`(`user_id`,`library_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`library_id`,`snapshot_id`) REFERENCES `account_study_snapshots`(`user_id`,`library_id`,`snapshot_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `account_study_item_versions` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`item_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`item_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`, `item_key`, `content_hash`),
	FOREIGN KEY (`user_id`,`library_id`) REFERENCES `account_study_libraries`(`user_id`,`library_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `account_study_libraries` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`),
	FOREIGN KEY (`user_id`) REFERENCES `learning_accounts`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `account_study_records` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`event_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`core_hash` text NOT NULL,
	`envelope_hash` text NOT NULL,
	`record_json` text NOT NULL,
	FOREIGN KEY (`user_id`,`library_id`,`snapshot_id`) REFERENCES `account_study_snapshots`(`user_id`,`library_id`,`snapshot_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_record_event_uq` ON `account_study_records` (`user_id`,`library_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `account_study_record_cursor_idx` ON `account_study_records` (`user_id`,`library_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `account_study_snapshot_members` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`position` integer NOT NULL,
	`item_key` text NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`, `snapshot_id`, `position`),
	FOREIGN KEY (`user_id`,`library_id`,`snapshot_id`) REFERENCES `account_study_snapshots`(`user_id`,`library_id`,`snapshot_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`library_id`,`item_key`,`content_hash`) REFERENCES `account_study_item_versions`(`user_id`,`library_id`,`item_key`,`content_hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_member_item_uq` ON `account_study_snapshot_members` (`user_id`,`library_id`,`snapshot_id`,`item_key`);--> statement-breakpoint
CREATE TABLE `account_study_snapshots` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`revision` integer NOT NULL,
	`snapshot_hash` text NOT NULL,
	`header_json` text NOT NULL,
	`member_count` integer NOT NULL,
	`published` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`, `snapshot_id`),
	FOREIGN KEY (`user_id`,`library_id`) REFERENCES `account_study_libraries`(`user_id`,`library_id`) ON UPDATE no action ON DELETE cascade
);
