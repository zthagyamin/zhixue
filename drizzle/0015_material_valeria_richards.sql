ALTER TABLE `account_study_ai_requests` ADD `operation_kind` text DEFAULT 'legacy-unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `account_study_ai_requests` ADD `model_id` text DEFAULT 'legacy-unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `account_study_ai_requests` ADD `prompt_version` text DEFAULT 'legacy-unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `account_study_ai_requests` ADD `rule_version` text DEFAULT 'legacy-unknown' NOT NULL;