DROP TABLE `progress_counters`;--> statement-breakpoint
ALTER TABLE `learning_item_states` ADD `last_event_sequence` integer DEFAULT 0 NOT NULL;