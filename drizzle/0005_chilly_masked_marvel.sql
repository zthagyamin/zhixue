CREATE TABLE `account_study_manifest_pages` (
	`user_id` text NOT NULL,
	`library_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`page` integer NOT NULL,
	`page_hash` text NOT NULL,
	`page_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `library_id`, `snapshot_id`, `page`),
	FOREIGN KEY (`user_id`,`library_id`,`snapshot_id`) REFERENCES `account_study_snapshots`(`user_id`,`library_id`,`snapshot_id`) ON UPDATE no action ON DELETE cascade
);
