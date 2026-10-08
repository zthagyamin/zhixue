CREATE TABLE `account_study_content_decision_receipts` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`status` text NOT NULL,
	`payload_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`writer_grant_id` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`writer_grant_id`) REFERENCES `account_study_grants`(`grant_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`library_id`,`operation_id`) REFERENCES `account_study_content_decisions`(`user_id`,`library_id`,`operation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_content_decision_receipt_uq` ON `account_study_content_decision_receipts` (`user_id`,`library_id`,`receipt_id`);--> statement-breakpoint
CREATE INDEX `account_study_content_decision_receipt_cursor_idx` ON `account_study_content_decision_receipts` (`user_id`,`library_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `account_study_content_decisions` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`facts_hash` text NOT NULL,
	`candidate_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`decision` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`,`library_id`,`facts_hash`) REFERENCES `account_study_planning_facts`(`user_id`,`library_id`,`facts_hash`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_content_decision_operation_uq` ON `account_study_content_decisions` (`user_id`,`library_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `account_study_content_decision_cursor_idx` ON `account_study_content_decisions` (`user_id`,`library_id`,`sequence`);--> statement-breakpoint
ALTER TABLE `account_study_ai_settings` ADD `credential_ciphertext` text;--> statement-breakpoint
ALTER TABLE `account_study_ai_settings` ADD `credential_nonce` text;