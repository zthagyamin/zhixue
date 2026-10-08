CREATE TABLE `account_study_grants` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text NOT NULL,
	`expected_profile_revision` integer NOT NULL,
	`replace_library` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`user_id`,`library_id`) REFERENCES `account_study_libraries`(`user_id`,`library_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_grant_token_uq` ON `account_study_grants` (`token_hash`);--> statement-breakpoint
CREATE INDEX `account_study_grant_user_state_idx` ON `account_study_grants` (`user_id`,`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `account_study_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`library_id` text,
	`revision` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `learning_accounts`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`library_id`) REFERENCES `account_study_libraries`(`user_id`,`library_id`) ON UPDATE no action ON DELETE no action
);
