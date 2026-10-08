CREATE TABLE `account_long_term_plan_operations` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`state_revision` integer NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`,`library_id`) REFERENCES `account_long_term_plan_states`(`user_id`,`library_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_long_term_operation_uq` ON `account_long_term_plan_operations` (`user_id`,`library_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `account_long_term_operation_cursor_idx` ON `account_long_term_plan_operations` (`user_id`,`library_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `account_long_term_plan_states` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`state_json` text,
	`last_operation_id` text,
	PRIMARY KEY(`user_id`, `library_id`),
	FOREIGN KEY (`user_id`,`library_id`) REFERENCES `account_study_libraries`(`user_id`,`library_id`) ON UPDATE no action ON DELETE cascade
);
