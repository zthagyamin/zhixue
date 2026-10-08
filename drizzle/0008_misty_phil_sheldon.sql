CREATE TABLE `account_study_plan_operations` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`day` text NOT NULL,
	`operation_id` text NOT NULL,
	`action` text NOT NULL,
	`request_hash` text NOT NULL,
	`plan_hash` text,
	`plan_json` text,
	`state_revision` integer NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`,`library_id`,`day`) REFERENCES `account_study_plan_states`(`user_id`,`library_id`,`day`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_plan_operation_uq` ON `account_study_plan_operations` (`user_id`,`library_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `account_study_plan_operation_cursor_idx` ON `account_study_plan_operations` (`user_id`,`library_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `account_study_plan_states` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`day` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`plan_hash` text,
	`plan_json` text,
	`approved_plan_hash` text,
	`approved_plan_json` text,
	`approved_revision` integer,
	`decision` text DEFAULT 'none' NOT NULL,
	`last_operation_id` text,
	PRIMARY KEY(`user_id`, `library_id`, `day`),
	FOREIGN KEY (`user_id`,`library_id`) REFERENCES `account_study_libraries`(`user_id`,`library_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_study_plan_approved_idx` ON `account_study_plan_states` (`user_id`,`library_id`,`approved_revision`);--> statement-breakpoint
CREATE TABLE `account_study_planning_catalogs` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`catalog_hash` text NOT NULL,
	`catalog_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`, `snapshot_id`),
	FOREIGN KEY (`user_id`,`library_id`,`snapshot_id`) REFERENCES `account_study_snapshots`(`user_id`,`library_id`,`snapshot_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_catalog_source_uq` ON `account_study_planning_catalogs` (`user_id`,`library_id`,`source_hash`);