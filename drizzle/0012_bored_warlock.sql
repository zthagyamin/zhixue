CREATE TABLE `account_study_ai_requests` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`request_id` text NOT NULL,
	`day` text NOT NULL,
	`input_hash` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`usage_tokens` integer,
	`error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`, `request_id`),
	FOREIGN KEY (`user_id`,`library_id`) REFERENCES `account_study_ai_settings`(`user_id`,`library_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_study_ai_request_day_idx` ON `account_study_ai_requests` (`user_id`,`library_id`,`day`,`status`);--> statement-breakpoint
CREATE TABLE `account_study_ai_settings` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`daily_request_limit` integer DEFAULT 3 NOT NULL,
	`max_output_tokens` integer DEFAULT 500 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`),
	FOREIGN KEY (`user_id`,`library_id`) REFERENCES `account_study_libraries`(`user_id`,`library_id`) ON UPDATE no action ON DELETE cascade
);
