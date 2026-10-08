CREATE TABLE `account_study_plan_execution_receipts` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`cloud_plan_hash` text NOT NULL,
	`status` text NOT NULL,
	`payload_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`writer_grant_id` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`writer_grant_id`) REFERENCES `account_study_grants`(`grant_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`library_id`,`operation_id`) REFERENCES `account_study_plan_operations`(`user_id`,`library_id`,`operation_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_plan_execution_receipt_uq` ON `account_study_plan_execution_receipts` (`user_id`,`library_id`,`receipt_id`);--> statement-breakpoint
CREATE INDEX `account_study_plan_execution_cursor_idx` ON `account_study_plan_execution_receipts` (`user_id`,`library_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `account_study_plan_execution_operation_idx` ON `account_study_plan_execution_receipts` (`user_id`,`library_id`,`operation_id`,`sequence`);--> statement-breakpoint
ALTER TABLE `account_study_plan_operations` ADD `predecessor_operation_id` text;--> statement-breakpoint
ALTER TABLE `account_study_plan_states` ADD `approved_operation_id` text;