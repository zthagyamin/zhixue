CREATE TABLE `account_study_content_decision_finals` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`operation_id` text NOT NULL,
	`decision` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`, `candidate_id`, `content_hash`),
	FOREIGN KEY (`user_id`,`library_id`) REFERENCES `account_study_libraries`(`user_id`,`library_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `account_study_plan_claims` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`writer_grant_id` text NOT NULL,
	`state` text NOT NULL,
	`lease_until` text NOT NULL,
	`claimed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`, `operation_id`),
	FOREIGN KEY (`writer_grant_id`) REFERENCES `account_study_grants`(`grant_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`library_id`,`operation_id`) REFERENCES `account_study_plan_operations`(`user_id`,`library_id`,`operation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_study_plan_claim_lease_idx` ON `account_study_plan_claims` (`user_id`,`library_id`,`state`,`lease_until`);--> statement-breakpoint
ALTER TABLE `account_study_ai_requests` ADD `reserved_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `account_study_ai_settings` ADD `daily_token_limit` integer DEFAULT 3000 NOT NULL;--> statement-breakpoint
ALTER TABLE `account_study_ai_settings` ADD `concurrent_limit` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_content_decision_operation_receipt_uq` ON `account_study_content_decision_receipts` (`user_id`,`library_id`,`operation_id`);