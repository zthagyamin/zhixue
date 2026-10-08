CREATE TABLE `learning_progress_migrations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`migration_event_id` text NOT NULL,
	`progress_json` text NOT NULL,
	`migrated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `learning_accounts`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learning_progress_migrations_migration_event_id_unique` ON `learning_progress_migrations` (`migration_event_id`);