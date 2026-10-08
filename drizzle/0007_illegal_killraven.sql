CREATE TABLE `account_study_writeback_receipts` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`event_id` text NOT NULL,
	`envelope_hash` text NOT NULL,
	`status` text NOT NULL,
	`payload_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`writer_grant_id` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`writer_grant_id`) REFERENCES `account_study_grants`(`grant_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`,`library_id`,`event_id`) REFERENCES `account_study_records`(`user_id`,`library_id`,`event_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_receipt_id_uq` ON `account_study_writeback_receipts` (`user_id`,`library_id`,`receipt_id`);--> statement-breakpoint
CREATE INDEX `account_study_receipt_cursor_idx` ON `account_study_writeback_receipts` (`user_id`,`library_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `account_study_receipt_event_idx` ON `account_study_writeback_receipts` (`user_id`,`library_id`,`event_id`,`sequence`);