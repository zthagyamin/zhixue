CREATE TABLE `account_study_planning_facts` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`catalog_hash` text NOT NULL,
	`facts_hash` text NOT NULL,
	`observed_at` text NOT NULL,
	`facts_json` text NOT NULL,
	FOREIGN KEY (`user_id`,`library_id`,`snapshot_id`) REFERENCES `account_study_planning_catalogs`(`user_id`,`library_id`,`snapshot_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_facts_hash_uq` ON `account_study_planning_facts` (`user_id`,`library_id`,`facts_hash`);--> statement-breakpoint
CREATE INDEX `account_study_facts_snapshot_idx` ON `account_study_planning_facts` (`user_id`,`library_id`,`snapshot_id`,`sequence`);