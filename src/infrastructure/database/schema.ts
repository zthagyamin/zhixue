import { sql } from "drizzle-orm";
import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const learningAttemptsV1 = sqliteTable('learning_attempts_v1', {
  userId: text('user_id').notNull(), libraryId: text('library_id').notNull(), attemptId: text('attempt_id').notNull(),
  groupId: text('group_id').notNull(), revision: integer('revision').notNull(), attemptJson: text('attempt_json').notNull(),
  formalEventId: text('formal_event_id'), formalLogicalKey: text('formal_logical_key'), updatedAt: text('updated_at').notNull(),
}, t => [primaryKey({columns: [t.userId, t.libraryId, t.attemptId]}),
  uniqueIndex('learning_attempts_v1_formal_uq').on(t.userId, t.libraryId, t.formalEventId),
  uniqueIndex('learning_attempts_v1_logical_uq').on(t.userId, t.libraryId, t.formalLogicalKey),
  index('learning_attempts_v1_group_idx').on(t.userId, t.libraryId, t.groupId, t.updatedAt),
  foreignKey({columns: [t.userId, t.libraryId], foreignColumns: [accountStudyLibraries.userId, accountStudyLibraries.libraryId]}).onDelete('cascade')]);

export const learningAccounts = sqliteTable("learning_accounts", {
  userId: text("user_id").primaryKey(),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  syncMode: text("sync_mode").notNull().default("balanced"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const learningItemStates = sqliteTable("learning_item_states", {
  userId: text("user_id").notNull().references(() => learningAccounts.userId, { onDelete: "cascade" }),
  itemKind: text("item_kind").notNull(),
  itemKey: text("item_key").notNull(),
  numericValue: integer("numeric_value").notNull().default(0),
  state: text("state").notNull().default("pending"),
  version: integer("version").notNull().default(1),
  lastEventSequence: integer("last_event_sequence").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  deletedAt: text("deleted_at"),
}, (table) => [
  primaryKey({ columns: [table.userId, table.itemKind, table.itemKey] }),
  index("idx_learning_item_states_user_kind").on(table.userId, table.itemKind),
]);

export const learningProgressMigrations = sqliteTable("learning_progress_migrations", {
  userId: text("user_id").primaryKey().references(() => learningAccounts.userId, { onDelete: "cascade" }),
  migrationEventId: text("migration_event_id").notNull().unique(),
  progressJson: text("progress_json").notNull(),
  migratedAt: text("migrated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const learningEvents = sqliteTable("learning_events", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull(),
  userId: text("user_id").notNull().references(() => learningAccounts.userId, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  itemKind: text("item_kind").notNull(),
  itemKey: text("item_key").notNull(),
  eventType: text("event_type").notNull(),
  outcome: text("outcome").notNull(),
  numericValue: integer("numeric_value"),
  answeredDelta: integer("answered_delta").notNull().default(0),
  correctDelta: integer("correct_delta").notNull().default(0),
  occurredAt: text("occurred_at").notNull(),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("uidx_learning_events_user_event").on(table.userId, table.eventId),
  index("idx_learning_events_user_sequence").on(table.userId, table.sequence),
]);

export const studyEventsV3 = sqliteTable("study_events_v3", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => learningAccounts.userId, { onDelete: "cascade" }),
  eventId: text("event_id").notNull(),
  coreHash: text("core_hash").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  occurredAt: text("occurred_at").notNull(),
  domain: text("domain").notNull(),
  eventType: text("event_type").notNull(),
  itemKind: text("item_kind").notNull(),
  itemKey: text("item_key").notNull(),
  stateHandle: text("state_handle"),
  rating: text("rating"),
  correct: integer("correct", { mode: "boolean" }),
  stageBefore: integer("stage_before"),
  stageAfter: integer("stage_after"),
  reviewedAt: text("reviewed_at"),
  schedulerVersion: text("scheduler_version"),
  clientProjectionJson: text("client_projection_json"),
  baselineJson: text("baseline_json"),
  receivedAt: text("received_at").notNull(),
}, (table) => ({
  userEventUnique: uniqueIndex("study_events_v3_user_event_uq").on(table.userId, table.eventId),
  replayIndex: index("study_events_v3_replay_idx").on(table.userId, table.itemKind, table.itemKey, table.reviewedAt, table.eventId),
  cursorIndex: index("study_events_v3_cursor_idx").on(table.userId, table.sequence),
}));

export const reviewProjections = sqliteTable("review_projections", {
  userId: text("user_id").notNull().references(() => learningAccounts.userId, { onDelete: "cascade" }),
  itemKind: text("item_kind").notNull(),
  itemKey: text("item_key").notNull(),
  fsrsJson: text("fsrs_json").notNull(),
  dueAt: text("due_at").notNull(),
  schedulerVersion: text("scheduler_version").notNull(),
  appliedEventCount: integer("applied_event_count").notNull(),
  eventSetHash: text("event_set_hash").notNull(),
  lastReviewedAt: text("last_reviewed_at"),
  source: text("source").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.itemKind, table.itemKey] }),
  index("review_projections_due_idx").on(table.userId, table.dueAt),
]);

// New storage is isolated from the legacy feed and its learning projections.
export const accountStudyLibraries=sqliteTable('account_study_libraries',{
  userId:text('user_id').notNull().references(()=>learningAccounts.userId,{onDelete:'cascade'}),
  libraryId:text('library_id').notNull(),
},t=>[primaryKey({columns:[t.userId,t.libraryId]})]);

export const accountStudySnapshots=sqliteTable('account_study_snapshots',{
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),snapshotId:text('snapshot_id').notNull(),
  revision:integer('revision').notNull(),snapshotHash:text('snapshot_hash').notNull(),headerJson:text('header_json').notNull(),
  memberCount:integer('member_count').notNull(),published:integer('published').notNull().default(0),
},t=>[primaryKey({columns:[t.userId,t.libraryId,t.snapshotId]}),
  foreignKey({columns:[t.userId,t.libraryId],foreignColumns:[accountStudyLibraries.userId,accountStudyLibraries.libraryId]}).onDelete('cascade')]);

export const accountStudyHeads=sqliteTable('account_study_heads',{
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),snapshotId:text('snapshot_id'),revision:integer('revision').notNull().default(0),
},t=>[primaryKey({columns:[t.userId,t.libraryId]}),
  foreignKey({columns:[t.userId,t.libraryId],foreignColumns:[accountStudyLibraries.userId,accountStudyLibraries.libraryId]}).onDelete('cascade'),
  foreignKey({columns:[t.userId,t.libraryId,t.snapshotId],foreignColumns:[accountStudySnapshots.userId,accountStudySnapshots.libraryId,accountStudySnapshots.snapshotId]})]);

export const accountStudyManifestPages=sqliteTable('account_study_manifest_pages',{
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),snapshotId:text('snapshot_id').notNull(),
  page:integer('page').notNull(),pageHash:text('page_hash').notNull(),pageJson:text('page_json').notNull(),
},t=>[primaryKey({columns:[t.userId,t.libraryId,t.snapshotId,t.page]}),
  foreignKey({columns:[t.userId,t.libraryId,t.snapshotId],foreignColumns:[accountStudySnapshots.userId,accountStudySnapshots.libraryId,accountStudySnapshots.snapshotId]}).onDelete('cascade')]);

export const accountStudyItemVersions=sqliteTable('account_study_item_versions',{
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),itemKey:text('item_key').notNull(),
  contentHash:text('content_hash').notNull(),itemJson:text('item_json').notNull(),
},t=>[primaryKey({columns:[t.userId,t.libraryId,t.itemKey,t.contentHash]}),
  foreignKey({columns:[t.userId,t.libraryId],foreignColumns:[accountStudyLibraries.userId,accountStudyLibraries.libraryId]}).onDelete('cascade')]);

export const accountStudySnapshotMembers=sqliteTable('account_study_snapshot_members',{
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),snapshotId:text('snapshot_id').notNull(),
  position:integer('position').notNull(),itemKey:text('item_key').notNull(),contentHash:text('content_hash').notNull(),
},t=>[primaryKey({columns:[t.userId,t.libraryId,t.snapshotId,t.position]}),
  uniqueIndex('account_study_member_item_uq').on(t.userId,t.libraryId,t.snapshotId,t.itemKey),
  foreignKey({columns:[t.userId,t.libraryId,t.snapshotId],foreignColumns:[accountStudySnapshots.userId,accountStudySnapshots.libraryId,accountStudySnapshots.snapshotId]}).onDelete('cascade'),
  foreignKey({columns:[t.userId,t.libraryId,t.itemKey,t.contentHash],foreignColumns:[accountStudyItemVersions.userId,accountStudyItemVersions.libraryId,accountStudyItemVersions.itemKey,accountStudyItemVersions.contentHash]})]);

export const accountStudyRecords=sqliteTable('account_study_records',{
  sequence:integer('sequence').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),
  eventId:text('event_id').notNull(),snapshotId:text('snapshot_id').notNull(),coreHash:text('core_hash').notNull(),
  envelopeHash:text('envelope_hash').notNull(),recordJson:text('record_json').notNull(),
},t=>[uniqueIndex('account_study_record_event_uq').on(t.userId,t.libraryId,t.eventId),
  index('account_study_record_cursor_idx').on(t.userId,t.libraryId,t.sequence),
  foreignKey({columns:[t.userId,t.libraryId,t.snapshotId],foreignColumns:[accountStudySnapshots.userId,accountStudySnapshots.libraryId,accountStudySnapshots.snapshotId]})]);

export const accountStudyProfiles=sqliteTable('account_study_profiles',{
  userId:text('user_id').primaryKey().references(()=>learningAccounts.userId,{onDelete:'cascade'}),
  libraryId:text('library_id'),revision:integer('revision').notNull().default(0),
},t=>[foreignKey({columns:[t.userId,t.libraryId],foreignColumns:[accountStudyLibraries.userId,accountStudyLibraries.libraryId]})]);

export const accountStudyGrants=sqliteTable('account_study_grants',{
  grantId:text('grant_id').primaryKey(),userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),
  tokenHash:text('token_hash').notNull(),label:text('label').notNull(),expectedProfileRevision:integer('expected_profile_revision').notNull(),
  replaceLibrary:integer('replace_library').notNull(),createdAt:text('created_at').notNull(),expiresAt:text('expires_at').notNull(),state:text('state').notNull(),
},t=>[uniqueIndex('account_study_grant_token_uq').on(t.tokenHash),index('account_study_grant_user_state_idx').on(t.userId,t.state,t.expiresAt),
  foreignKey({columns:[t.userId,t.libraryId],foreignColumns:[accountStudyLibraries.userId,accountStudyLibraries.libraryId]}).onDelete('cascade')]);

export const accountStudyWritebackReceipts=sqliteTable('account_study_writeback_receipts',{
  sequence:integer('sequence').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),
  receiptId:text('receipt_id').notNull(),eventId:text('event_id').notNull(),envelopeHash:text('envelope_hash').notNull(),status:text('status').notNull(),
  payloadHash:text('payload_hash').notNull(),payloadJson:text('payload_json').notNull(),writerGrantId:text('writer_grant_id').notNull().references(()=>accountStudyGrants.grantId),
  receivedAt:text('received_at').notNull(),
},t=>[uniqueIndex('account_study_receipt_id_uq').on(t.userId,t.libraryId,t.receiptId),
  index('account_study_receipt_cursor_idx').on(t.userId,t.libraryId,t.sequence),
  index('account_study_receipt_event_idx').on(t.userId,t.libraryId,t.eventId,t.sequence),
  foreignKey({columns:[t.userId,t.libraryId,t.eventId],foreignColumns:[accountStudyRecords.userId,accountStudyRecords.libraryId,accountStudyRecords.eventId]}).onDelete('cascade')]);

export const accountStudyPlanningCatalogs=sqliteTable('account_study_planning_catalogs',{
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),snapshotId:text('snapshot_id').notNull(),
  sourceHash:text('source_hash').notNull(),catalogHash:text('catalog_hash').notNull(),catalogJson:text('catalog_json').notNull(),
},t=>[primaryKey({columns:[t.userId,t.libraryId,t.snapshotId]}),
  index('account_study_catalog_source_idx').on(t.userId,t.libraryId,t.sourceHash),uniqueIndex('account_study_catalog_hash_uq').on(t.userId,t.libraryId,t.catalogHash),
  foreignKey({columns:[t.userId,t.libraryId,t.snapshotId],foreignColumns:[accountStudySnapshots.userId,accountStudySnapshots.libraryId,accountStudySnapshots.snapshotId]}).onDelete('cascade')]);

export const accountStudyPlanningFacts=sqliteTable('account_study_planning_facts',{
  sequence:integer('sequence').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),snapshotId:text('snapshot_id').notNull(),
  catalogHash:text('catalog_hash').notNull(),factsHash:text('facts_hash').notNull(),observedAt:text('observed_at').notNull(),factsJson:text('facts_json').notNull(),
},t=>[uniqueIndex('account_study_facts_hash_uq').on(t.userId,t.libraryId,t.factsHash),index('account_study_facts_snapshot_idx').on(t.userId,t.libraryId,t.snapshotId,t.sequence),
  foreignKey({columns:[t.userId,t.libraryId,t.snapshotId],foreignColumns:[accountStudyPlanningCatalogs.userId,accountStudyPlanningCatalogs.libraryId,accountStudyPlanningCatalogs.snapshotId]}).onDelete('cascade')]);

export const accountLongTermPlanStates=sqliteTable('account_long_term_plan_states',{
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),revision:integer('revision').notNull().default(0),
  stateJson:text('state_json'),lastOperationId:text('last_operation_id'),
},t=>[primaryKey({columns:[t.userId,t.libraryId]}),
  foreignKey({columns:[t.userId,t.libraryId],foreignColumns:[accountStudyLibraries.userId,accountStudyLibraries.libraryId]}).onDelete('cascade')]);

export const accountLongTermPlanOperations=sqliteTable('account_long_term_plan_operations',{
  sequence:integer('sequence').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),
  operationId:text('operation_id').notNull(),requestHash:text('request_hash').notNull(),stateRevision:integer('state_revision').notNull(),
  beforeJson:text('before_json').notNull(),afterJson:text('after_json').notNull(),receivedAt:text('received_at').notNull().default(sql`CURRENT_TIMESTAMP`),
},t=>[uniqueIndex('account_long_term_operation_uq').on(t.userId,t.libraryId,t.operationId),
  index('account_long_term_operation_cursor_idx').on(t.userId,t.libraryId,t.sequence),
  foreignKey({columns:[t.userId,t.libraryId],foreignColumns:[accountLongTermPlanStates.userId,accountLongTermPlanStates.libraryId]}).onDelete('cascade')]);

export const accountStudyPlanStates=sqliteTable('account_study_plan_states',{
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),day:text('day').notNull(),revision:integer('revision').notNull().default(0),
  planHash:text('plan_hash'),planJson:text('plan_json'),approvedPlanHash:text('approved_plan_hash'),approvedPlanJson:text('approved_plan_json'),
  approvedRevision:integer('approved_revision'),approvedOperationId:text('approved_operation_id'),decision:text('decision').notNull().default('none'),lastOperationId:text('last_operation_id'),
},t=>[primaryKey({columns:[t.userId,t.libraryId,t.day]}),
  index('account_study_plan_approved_idx').on(t.userId,t.libraryId,t.approvedRevision),
  foreignKey({columns:[t.userId,t.libraryId],foreignColumns:[accountStudyLibraries.userId,accountStudyLibraries.libraryId]}).onDelete('cascade')]);

export const accountStudyPlanOperations=sqliteTable('account_study_plan_operations',{
  sequence:integer('sequence').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),day:text('day').notNull(),
  operationId:text('operation_id').notNull(),action:text('action').notNull(),requestHash:text('request_hash').notNull(),
  planHash:text('plan_hash'),planJson:text('plan_json'),predecessorOperationId:text('predecessor_operation_id'),stateRevision:integer('state_revision').notNull(),receivedAt:text('received_at').notNull().default(sql`CURRENT_TIMESTAMP`),
},t=>[uniqueIndex('account_study_plan_operation_uq').on(t.userId,t.libraryId,t.operationId),
  index('account_study_plan_operation_cursor_idx').on(t.userId,t.libraryId,t.sequence),
  foreignKey({columns:[t.userId,t.libraryId,t.day],foreignColumns:[accountStudyPlanStates.userId,accountStudyPlanStates.libraryId,accountStudyPlanStates.day]}).onDelete('cascade')]);

export const accountStudyPlanExecutionReceipts=sqliteTable('account_study_plan_execution_receipts',{
  sequence:integer('sequence').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),receiptId:text('receipt_id').notNull(),
  operationId:text('operation_id').notNull(),cloudPlanHash:text('cloud_plan_hash').notNull(),status:text('status').notNull(),payloadHash:text('payload_hash').notNull(),
  payloadJson:text('payload_json').notNull(),writerGrantId:text('writer_grant_id').notNull().references(()=>accountStudyGrants.grantId),receivedAt:text('received_at').notNull().default(sql`CURRENT_TIMESTAMP`),
},t=>[uniqueIndex('account_study_plan_execution_receipt_uq').on(t.userId,t.libraryId,t.receiptId),index('account_study_plan_execution_cursor_idx').on(t.userId,t.libraryId,t.sequence),
  index('account_study_plan_execution_operation_idx').on(t.userId,t.libraryId,t.operationId,t.sequence),
  foreignKey({columns:[t.userId,t.libraryId,t.operationId],foreignColumns:[accountStudyPlanOperations.userId,accountStudyPlanOperations.libraryId,accountStudyPlanOperations.operationId]}).onDelete('cascade')]);

export const accountStudyPlanClaims=sqliteTable('account_study_plan_claims',{
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),operationId:text('operation_id').notNull(),writerGrantId:text('writer_grant_id').notNull().references(()=>accountStudyGrants.grantId),state:text('state').notNull(),leaseUntil:text('lease_until').notNull(),claimedAt:text('claimed_at').notNull().default(sql`CURRENT_TIMESTAMP`),
},t=>[primaryKey({columns:[t.userId,t.libraryId,t.operationId]}),index('account_study_plan_claim_lease_idx').on(t.userId,t.libraryId,t.state,t.leaseUntil),foreignKey({columns:[t.userId,t.libraryId,t.operationId],foreignColumns:[accountStudyPlanOperations.userId,accountStudyPlanOperations.libraryId,accountStudyPlanOperations.operationId]}).onDelete('cascade')]);

export const accountStudyAiSettings=sqliteTable('account_study_ai_settings',{
  provider:text('provider').notNull().default('deepseek'),providerConfigs:text('provider_configs').notNull().default('{}'),
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),enabled:integer('enabled').notNull().default(0),dailyRequestLimit:integer('daily_request_limit').notNull().default(3),
  unlimitedDailyUsage:integer('unlimited_daily_usage').notNull().default(0),dailyTokenLimit:integer('daily_token_limit').notNull().default(3000),concurrentLimit:integer('concurrent_limit').notNull().default(1),maxOutputTokens:integer('max_output_tokens').notNull().default(500),credentialCiphertext:text('credential_ciphertext'),credentialNonce:text('credential_nonce'),revision:integer('revision').notNull().default(0),
},t=>[primaryKey({columns:[t.userId,t.libraryId]}),foreignKey({columns:[t.userId,t.libraryId],foreignColumns:[accountStudyLibraries.userId,accountStudyLibraries.libraryId]}).onDelete('cascade')]);

export const accountStudyAiRequests=sqliteTable('account_study_ai_requests',{
  providerId:text('provider_id').notNull().default('deepseek'),
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),requestId:text('request_id').notNull(),day:text('day').notNull(),inputHash:text('input_hash').notNull(),
  operationKind:text('operation_kind').notNull().default('legacy-unknown'),modelId:text('model_id').notNull().default('legacy-unknown'),promptVersion:text('prompt_version').notNull().default('legacy-unknown'),ruleVersion:text('rule_version').notNull().default('legacy-unknown'),
  status:text('status').notNull(),reservedTokens:integer('reserved_tokens').notNull().default(0),resultJson:text('result_json'),usageTokens:integer('usage_tokens'),errorCode:text('error_code'),createdAt:text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
},t=>[primaryKey({columns:[t.userId,t.libraryId,t.requestId]}),index('account_study_ai_request_day_idx').on(t.userId,t.libraryId,t.day,t.status),
  foreignKey({columns:[t.userId,t.libraryId],foreignColumns:[accountStudyAiSettings.userId,accountStudyAiSettings.libraryId]}).onDelete('cascade')]);

export const accountStudyContentDecisions=sqliteTable('account_study_content_decisions',{
  sequence:integer('sequence').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),operationId:text('operation_id').notNull(),factsHash:text('facts_hash').notNull(),candidateId:text('candidate_id').notNull(),contentHash:text('content_hash').notNull(),decision:text('decision').notNull(),requestHash:text('request_hash').notNull(),status:text('status').notNull(),receivedAt:text('received_at').notNull().default(sql`CURRENT_TIMESTAMP`),
},t=>[uniqueIndex('account_study_content_decision_operation_uq').on(t.userId,t.libraryId,t.operationId),index('account_study_content_decision_cursor_idx').on(t.userId,t.libraryId,t.sequence),foreignKey({columns:[t.userId,t.libraryId,t.factsHash],foreignColumns:[accountStudyPlanningFacts.userId,accountStudyPlanningFacts.libraryId,accountStudyPlanningFacts.factsHash]}).onDelete('cascade')]);

export const accountStudyContentDecisionFinals=sqliteTable('account_study_content_decision_finals',{
  userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),candidateId:text('candidate_id').notNull(),contentHash:text('content_hash').notNull(),operationId:text('operation_id').notNull(),decision:text('decision').notNull(),createdAt:text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
},t=>[primaryKey({columns:[t.userId,t.libraryId,t.candidateId,t.contentHash]}),foreignKey({columns:[t.userId,t.libraryId],foreignColumns:[accountStudyLibraries.userId,accountStudyLibraries.libraryId]}).onDelete('cascade')]);

export const accountStudyContentDecisionReceipts=sqliteTable('account_study_content_decision_receipts',{
  sequence:integer('sequence').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),receiptId:text('receipt_id').notNull(),operationId:text('operation_id').notNull(),status:text('status').notNull(),payloadHash:text('payload_hash').notNull(),payloadJson:text('payload_json').notNull(),writerGrantId:text('writer_grant_id').notNull().references(()=>accountStudyGrants.grantId),receivedAt:text('received_at').notNull().default(sql`CURRENT_TIMESTAMP`),
},t=>[uniqueIndex('account_study_content_decision_receipt_uq').on(t.userId,t.libraryId,t.receiptId),uniqueIndex('account_study_content_decision_operation_receipt_uq').on(t.userId,t.libraryId,t.operationId),index('account_study_content_decision_receipt_cursor_idx').on(t.userId,t.libraryId,t.sequence),foreignKey({columns:[t.userId,t.libraryId,t.operationId],foreignColumns:[accountStudyContentDecisions.userId,accountStudyContentDecisions.libraryId,accountStudyContentDecisions.operationId]}).onDelete('cascade')]);

// Auxiliary evidence is separate from V3 events and their state projections.
// Upgrades/rollbacks retain these append-only tables; no destructive migration.
export const accountStudyAssistance=sqliteTable('account_study_assistance',{
  sequence:integer('sequence').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),
  summaryId:text('summary_id').notNull(),eventId:text('event_id').notNull(),summaryHash:text('summary_hash').notNull(),
  associationHash:text('association_hash').notNull(),recordJson:text('record_json').notNull(),receivedAt:text('received_at').notNull(),
},t=>[uniqueIndex('account_study_assistance_id_uq').on(t.userId,t.libraryId,t.summaryId),uniqueIndex('account_study_assistance_event_uq').on(t.userId,t.libraryId,t.eventId),
  index('account_study_assistance_cursor_idx').on(t.userId,t.libraryId,t.sequence),
  foreignKey({columns:[t.userId,t.libraryId,t.eventId],foreignColumns:[accountStudyRecords.userId,accountStudyRecords.libraryId,accountStudyRecords.eventId]})]);

export const accountStudyAssistanceReceipts=sqliteTable('account_study_assistance_receipts',{
  sequence:integer('sequence').primaryKey({autoIncrement:true}),userId:text('user_id').notNull(),libraryId:text('library_id').notNull(),
  receiptId:text('receipt_id').notNull(),summaryId:text('summary_id').notNull(),status:text('status').notNull(),
  payloadHash:text('payload_hash').notNull(),payloadJson:text('payload_json').notNull(),writerGrantId:text('writer_grant_id').notNull().references(()=>accountStudyGrants.grantId),receivedAt:text('received_at').notNull(),
},t=>[uniqueIndex('account_study_assistance_receipt_id_uq').on(t.userId,t.libraryId,t.receiptId),index('account_study_assistance_receipt_cursor_idx').on(t.userId,t.libraryId,t.sequence),
  index('account_study_assistance_receipt_summary_idx').on(t.userId,t.libraryId,t.summaryId,t.sequence),
  foreignKey({columns:[t.userId,t.libraryId,t.summaryId],foreignColumns:[accountStudyAssistance.userId,accountStudyAssistance.libraryId,accountStudyAssistance.summaryId]})]);
