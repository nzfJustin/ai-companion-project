/**
 * src/db/schema.ts
 *
 * Drizzle ORM schema — AI Companion
 * Defines all tables across all four phases up-front.
 *
 * Phase 1 tables (active now):
 *   users, auth_sessions, user_memory_pins, user_context,
 *   conversations, messages, memories, emotional_snapshots,
 *   insight_reports, social_moods, social_connections
 *
 * Phase 3 tables (defined now, used later):
 *   user_streaks, user_milestones, social_mood_reactions, device_tokens
 *
 * Phase 4 tables (defined now, used later):
 *   user_subscriptions, memory_expiry_rules,
 *   partner_rewards, user_rewards, deletion_audit_log, data_exports
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  smallint,
  timestamp,
  date,
  jsonb,
  unique,
  index,
  customType,
} from 'drizzle-orm/pg-core';

// ─────────────────────────────────────────────────────────────────────────────
// Custom types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * bytea — raw binary (used for encrypted content + IVs).
 * drizzle-orm/pg-core exposes `bytea` directly in >=0.30; this
 * customType is a safe fallback for any version.
 */
export const bytea = customType<{ data: Buffer; driverData: string }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Buffer) {
    return value;
  },
  fromDriver(value: string) {
    if (Buffer.isBuffer(value)) return value as unknown as Buffer;
    return Buffer.from(value as unknown as string, 'hex');
  },
});

/**
 * vector — pgvector column (requires the vector extension).
 * See: 0000_enable_pgvector.sql
 */
export const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]) {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string) {
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(Number);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const commStyleEnum = pgEnum('comm_style', [
  'warm',
  'direct',
  'reflective',
]);

export const regionEnum = pgEnum('region', ['us', 'eu']);

export const conversationStatusEnum = pgEnum('conversation_status', [
  'active',
  'closed',
  'summarized',
  'extraction_failed',
]);

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant']);

export const visibilityEnum = pgEnum('visibility', ['friends', 'public']);

export const connectionStatusEnum = pgEnum('connection_status', [
  'pending',
  'accepted',
  'rejected',
  'blocked',
]);

export const subscriptionTierEnum = pgEnum('subscription_tier', [
  'free',
  'premium',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'cancelled',
  'past_due',
]);

export const notificationPlatformEnum = pgEnum('notification_platform', [
  'ios',
  'android',
  'web',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 tables
// ─────────────────────────────────────────────────────────────────────────────

// ── users ─────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id:           uuid('id').defaultRandom().primaryKey(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName:  text('display_name').notNull(),
  timezone:     text('timezone').notNull().default('UTC'),
  commStyle:    commStyleEnum('comm_style').notNull().default('warm'),
  onboardingDone: boolean('onboarding_done').notNull().default(false),
  region:       regionEnum('region').notNull().default('us'),
  /** { streak_reminders: boolean; milestones: boolean } */
  notificationPreferences: jsonb('notification_preferences')
    .$type<{ streak_reminders: boolean; milestones: boolean }>()
    .notNull()
    .default({ streak_reminders: true, milestones: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Soft-delete — anonymised by deletion job, not dropped */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// ── auth_sessions ─────────────────────────────────────────────────────────────

export const authSessions = pgTable(
  'auth_sessions',
  {
    id:           uuid('id').defaultRandom().primaryKey(),
    userId:       uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshToken: text('refresh_token').notNull().unique(),
    /** Token rotation family — reuse of any old token in the family triggers revocation */
    tokenFamily:  text('token_family').notNull(),
    expiresAt:    timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt:    timestamp('revoked_at', { withTimezone: true }),
    createdAt:    timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdIdx:     index('auth_sessions_user_id_idx').on(t.userId),
    tokenFamilyIdx: index('auth_sessions_token_family_idx').on(t.tokenFamily),
  }),
);

// ── user_memory_pins ──────────────────────────────────────────────────────────

export const userMemoryPins = pgTable('user_memory_pins', {
  id:        uuid('id').defaultRandom().primaryKey(),
  userId:    uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })
    .unique(),
  pinHash:   text('pin_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── user_context ──────────────────────────────────────────────────────────────

export const userContext = pgTable('user_context', {
  id:     uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })
    .unique(),
  contextSummary: text('context_summary'),
  statedGoals:    jsonb('stated_goals')
    .$type<string[]>()
    .notNull()
    .default([]),
  sessionCount:   integer('session_count').notNull().default(0),
  /** P2-08: compressed long-term conversation history */
  historySummary: text('history_summary'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── conversations ─────────────────────────────────────────────────────────────

export const conversations = pgTable(
  'conversations',
  {
    id:           uuid('id').defaultRandom().primaryKey(),
    userId:       uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status:       conversationStatusEnum('status').notNull().default('active'),
    messageCount: integer('message_count').notNull().default(0),
    startedAt:    timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt:      timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx:   index('conversations_user_id_idx').on(t.userId),
    statusIdx:   index('conversations_status_idx').on(t.status),
    startedAtIdx: index('conversations_started_at_idx').on(t.startedAt),
  }),
);

// ── messages ──────────────────────────────────────────────────────────────────

export const messages = pgTable(
  'messages',
  {
    id:             uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role:      messageRoleEnum('role').notNull(),
    /** AES-256-GCM encrypted message body */
    content:   bytea('content').notNull(),
    contentIv: bytea('content_iv').notNull(),
    /** { primary: string; score: number } — set on assistant messages */
    emotionTags: jsonb('emotion_tags')
      .$type<{ primary: string; score: number } | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversationIdIdx: index('messages_conversation_id_idx').on(t.conversationId),
    userIdIdx:         index('messages_user_id_idx').on(t.userId),
    createdAtIdx:      index('messages_created_at_idx').on(t.createdAt),
  }),
);

// ── memories ──────────────────────────────────────────────────────────────────

export const memories = pgTable(
  'memories',
  {
    id:             uuid('id').defaultRandom().primaryKey(),
    userId:         uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .references(() => conversations.id, { onDelete: 'set null' }),
    title:     text('title').notNull(),
    /** AES-256-GCM encrypted summary */
    summary:   bytea('summary').notNull(),
    summaryIv: bytea('summary_iv').notNull(),
    keyEvents:     jsonb('key_events').$type<string[]>().notNull().default([]),
    emotionalTags: jsonb('emotional_tags').$type<string[]>().notNull().default([]),
    dominantEmotion: text('dominant_emotion'),
    /** Sensitivity level 1–5. Higher = more protected (requires PIN) */
    level: integer('level').notNull().default(1),
    periodStart: date('period_start'),
    periodEnd:   date('period_end'),
    /** pgvector embedding — populated by background job in P2-01 */
    embedding: vector('embedding', { dimensions: 1536 }),
    /** P4-04: user-set expiry override */
    customExpiryDate: timestamp('custom_expiry_date', { withTimezone: true }),
    /** Soft-delete — hard-deleted by the deletion job */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx:       index('memories_user_id_idx').on(t.userId),
    levelIdx:        index('memories_level_idx').on(t.level),
    deletedAtIdx:    index('memories_deleted_at_idx').on(t.deletedAt),
    createdAtIdx:    index('memories_created_at_idx').on(t.createdAt),
    // NOTE: IVFFlat vector index is created via post_migrate_vector_index.sql
    // after at least ~1,000 rows exist (lists=100 requires ≥100× rows).
  }),
);

// ── emotional_snapshots ───────────────────────────────────────────────────────

export const emotionalSnapshots = pgTable(
  'emotional_snapshots',
  {
    id:             uuid('id').defaultRandom().primaryKey(),
    userId:         uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    snapshotDate:    date('snapshot_date').notNull(),
    dominantEmotion: text('dominant_emotion').notNull(),
    /**
     * { joy, sadness, anxiety, anger, calm, excitement }
     * Each value is a float 0.0–1.0
     */
    emotionScores: jsonb('emotion_scores')
      .$type<{
        joy:       number;
        sadness:   number;
        anxiety:   number;
        anger:     number;
        calm:      number;
        excitement: number;
      }>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userDateIdx: index('emotional_snapshots_user_date_idx').on(t.userId, t.snapshotDate),
  }),
);

// ── insight_reports ───────────────────────────────────────────────────────────

export const insightReports = pgTable(
  'insight_reports',
  {
    id:     uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportType:  text('report_type').notNull().default('weekly'),
    periodStart: date('period_start').notNull(),
    periodEnd:   date('period_end').notNull(),
    /** AES-256-GCM encrypted report body */
    content:   bytea('content').notNull(),
    contentIv: bytea('content_iv').notNull(),
    /** Pattern array — may be empty (pattern_data_insufficient) */
    patterns: jsonb('patterns')
      .$type<
        Array<{
          type:           string;
          description:    string;
          severity:       'low' | 'medium' | 'high';
          first_observed: string;
          frequency:      number;
        }>
      >()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Prevents duplicate weekly reports for the same period */
    userTypePeriodUniq: unique('insight_reports_user_type_period_uniq').on(
      t.userId,
      t.reportType,
      t.periodStart,
    ),
    userIdIdx: index('insight_reports_user_id_idx').on(t.userId),
  }),
);

// ── social_moods ──────────────────────────────────────────────────────────────

export const socialMoods = pgTable(
  'social_moods',
  {
    id:         uuid('id').defaultRandom().primaryKey(),
    userId:     uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    moodLabel:  text('mood_label').notNull(),
    intensity:  smallint('intensity').notNull(), // 1–5
    message:    varchar('message', { length: 140 }),
    visibility: visibilityEnum('visibility').notNull().default('friends'),
    sharedAt:   timestamp('shared_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt:  timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    userIdIdx:  index('social_moods_user_id_idx').on(t.userId),
    sharedAtIdx: index('social_moods_shared_at_idx').on(t.sharedAt),
  }),
);

// ── social_connections ────────────────────────────────────────────────────────

export const socialConnections = pgTable(
  'social_connections',
  {
    id:          uuid('id').defaultRandom().primaryKey(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addresseeId: uuid('addressee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status:    connectionStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Prevents duplicate connection requests between the same pair */
    pairUniq:    unique('social_connections_pair_uniq').on(t.requesterId, t.addresseeId),
    addresseeIdx: index('social_connections_addressee_idx').on(t.addresseeId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 tables
// ─────────────────────────────────────────────────────────────────────────────

// ── user_streaks ──────────────────────────────────────────────────────────────

export const userStreaks = pgTable('user_streaks', {
  userId:         uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })
    .primaryKey(),
  currentStreak:  integer('current_streak').notNull().default(0),
  longestStreak:  integer('longest_streak').notNull().default(0),
  lastActiveDate: date('last_active_date'),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── user_milestones ───────────────────────────────────────────────────────────

export const userMilestones = pgTable(
  'user_milestones',
  {
    id:            uuid('id').defaultRandom().primaryKey(),
    userId:        uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    milestoneType: text('milestone_type').notNull(),
    achievedAt:    timestamp('achieved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userMilestoneUniq: unique('user_milestones_user_type_uniq').on(t.userId, t.milestoneType),
  }),
);

// ── social_mood_reactions ─────────────────────────────────────────────────────

export const socialMoodReactions = pgTable(
  'social_mood_reactions',
  {
    id:           uuid('id').defaultRandom().primaryKey(),
    moodId:       uuid('mood_id')
      .notNull()
      .references(() => socialMoods.id, { onDelete: 'cascade' }),
    userId:       uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'support' | 'relatable' | 'sending_love' */
    reactionType: text('reaction_type').notNull(),
    createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** One reaction per user per mood */
    uniqueReaction: unique('social_mood_reactions_uniq').on(t.moodId, t.userId),
  }),
);

// ── device_tokens ─────────────────────────────────────────────────────────────

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id:       uuid('id').defaultRandom().primaryKey(),
    userId:   uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token:    text('token').notNull().unique(),
    platform: notificationPlatformEnum('platform').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('device_tokens_user_id_idx').on(t.userId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 tables
// ─────────────────────────────────────────────────────────────────────────────

// ── user_subscriptions ────────────────────────────────────────────────────────

export const userSubscriptions = pgTable('user_subscriptions', {
  id:                   uuid('id').defaultRandom().primaryKey(),
  userId:               uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })
    .unique(),
  tier:                 subscriptionTierEnum('tier').notNull().default('free'),
  status:               subscriptionStatusEnum('status').notNull().default('active'),
  currentPeriodEnd:     timestamp('current_period_end', { withTimezone: true }),
  stripeSubscriptionId: text('stripe_subscription_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── memory_expiry_rules ───────────────────────────────────────────────────────

export const memoryExpiryRules = pgTable(
  'memory_expiry_rules',
  {
    id:              uuid('id').defaultRandom().primaryKey(),
    userId:          uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    memoryLevel:     integer('memory_level').notNull(), // 1–5
    expiresAfterDays: integer('expires_after_days').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userLevelUniq: unique('memory_expiry_rules_user_level_uniq').on(t.userId, t.memoryLevel),
  }),
);

// ── partner_rewards ───────────────────────────────────────────────────────────

export const partnerRewards = pgTable('partner_rewards', {
  id:                 uuid('id').defaultRandom().primaryKey(),
  partnerName:        text('partner_name').notNull(),
  rewardDescription:  text('reward_description').notNull(),
  rewardCode:         text('reward_code').notNull(),
  milestoneTrigger:   text('milestone_trigger').notNull(),
  availableFrom:      timestamp('available_from', { withTimezone: true }).notNull(),
  availableUntil:     timestamp('available_until', { withTimezone: true }),
  maxRedemptions:     integer('max_redemptions'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── user_rewards ──────────────────────────────────────────────────────────────

export const userRewards = pgTable(
  'user_rewards',
  {
    id:         uuid('id').defaultRandom().primaryKey(),
    userId:     uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rewardId:   uuid('reward_id')
      .notNull()
      .references(() => partnerRewards.id, { onDelete: 'cascade' }),
    earnedAt:   timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  },
  (t) => ({
    userRewardUniq: unique('user_rewards_user_reward_uniq').on(t.userId, t.rewardId),
  }),
);

// ── deletion_audit_log ────────────────────────────────────────────────────────

export const deletionAuditLog = pgTable('deletion_audit_log', {
  id:          uuid('id').defaultRandom().primaryKey(),
  /** No FK — the user row is being deleted */
  userId:      uuid('user_id').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

// ── data_exports ──────────────────────────────────────────────────────────────

export const dataExports = pgTable('data_exports', {
  id:          uuid('id').defaultRandom().primaryKey(),
  userId:      uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** 'pending' | 'completed' | 'failed' */
  status:      text('status').notNull().default('pending'),
  filePath:    text('file_path'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
