CREATE TABLE `account_study_assistance` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`summary_id` text NOT NULL,
	`event_id` text NOT NULL,
	`summary_hash` text NOT NULL,
	`association_hash` text NOT NULL,
	`record_json` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`user_id`,`library_id`,`event_id`) REFERENCES `account_study_records`(`user_id`,`library_id`,`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_assistance_id_uq` ON `account_study_assistance` (`user_id`,`library_id`,`summary_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_assistance_event_uq` ON `account_study_assistance` (`user_id`,`library_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `account_study_assistance_cursor_idx` ON `account_study_assistance` (`user_id`,`library_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `account_study_assistance_receipts` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`summary_id` text NOT NULL,
	`status` text NOT NULL,
	`payload_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`writer_grant_id` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`writer_grant_id`) REFERENCES `account_study_grants`(`grant_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`library_id`,`summary_id`) REFERENCES `account_study_assistance`(`user_id`,`library_id`,`summary_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_assistance_receipt_id_uq` ON `account_study_assistance_receipts` (`user_id`,`library_id`,`receipt_id`);--> statement-breakpoint
CREATE INDEX `account_study_assistance_receipt_cursor_idx` ON `account_study_assistance_receipts` (`user_id`,`library_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `account_study_assistance_receipt_summary_idx` ON `account_study_assistance_receipts` (`user_id`,`library_id`,`summary_id`,`sequence`);