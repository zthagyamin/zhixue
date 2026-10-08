DROP INDEX `account_study_catalog_source_uq`;--> statement-breakpoint
CREATE INDEX `account_study_catalog_source_idx` ON `account_study_planning_catalogs` (`user_id`,`library_id`,`source_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_study_catalog_hash_uq` ON `account_study_planning_catalogs` (`user_id`,`library_id`,`catalog_hash`);