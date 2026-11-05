import { z } from 'zod';
import type { Settings } from './types';

/** Runtime validation for anything crossing the IPC boundary or loaded from disk. */

export const BillingPolicySchema = z.object({
  incrementMinutes: z.number().int().min(1).max(60),
  minimumMinutes: z.number().int().min(1).max(240).nullable(),
  roundingMode: z.enum(['up', 'nearest', 'down']),
  allowTaskAggregation: z.boolean(),
  minimumConfidence: z.number().min(0).max(1),
});

const stringList = z.array(z.string().trim().min(1).max(200)).max(500);

export const SettingsSchema = z.object({
  captureSource: z.enum(['macos', 'windows']),
  startMonitoringOnLaunch: z.boolean(),
  pollIntervalSeconds: z.number().int().min(5).max(60),
  idleThresholdMinutes: z.number().int().min(1).max(60),
  sessionGapMinutes: z.number().int().min(1).max(240),
  excludedApplications: stringList,
  excludedDomains: stringList,
  excludedTitleKeywords: stringList,
  retentionDays: z.number().int().min(0).max(3650),
  billingPolicy: BillingPolicySchema,
});

export const SettingsPatchSchema = SettingsSchema.partial().extend({
  billingPolicy: BillingPolicySchema.partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/**
 * Defaults are deliberately conservative placeholders. Billing rules in particular
 * must be confirmed against the firm's actual policy (see docs/billing-policy.md).
 */
export const DEFAULT_SETTINGS: Settings = {
  captureSource: 'macos',
  // Never start real capture before the user has explicitly started it.
  startMonitoringOnLaunch: false,
  pollIntervalSeconds: 15,
  idleThresholdMinutes: 5,
  sessionGapMinutes: 15,
  excludedApplications: [
    '1Password',
    'Bitwarden',
    'KeePassXC',
    'LastPass',
    'Keychain Access',
    'loginwindow',
    'ScreenSaverEngine',
    'LockApp',
    'CredentialUIBroker',
  ],
  excludedDomains: [],
  excludedTitleKeywords: ['Incognito', 'Private Browsing', 'InPrivate'],
  retentionDays: 0,
  billingPolicy: {
    incrementMinutes: 6,
    minimumMinutes: null,
    roundingMode: 'up',
    allowTaskAggregation: false,
    minimumConfidence: 0.7,
  },
};

/** Defaults for the platform the app is running on (capture source follows the OS). */
export function defaultSettings(platform: string): Settings {
  return { ...DEFAULT_SETTINGS, captureSource: platform === 'win32' ? 'windows' : 'macos' };
}

export function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  return SettingsSchema.parse({
    ...base,
    ...patch,
    billingPolicy: { ...base.billingPolicy, ...(patch.billingPolicy ?? {}) },
  });
}

export const MatterInputSchema = z.object({
  clientName: z.string().trim().min(1).max(200),
  matterName: z.string().trim().min(1).max(200),
  displayName: z.string().trim().max(200).optional(),
  aliases: stringList.optional(),
  keywords: stringList.optional(),
});
export type MatterInput = z.infer<typeof MatterInputSchema>;

export const IdSchema = z.string().min(1).max(100);

const epochMs = z.number().int().nonnegative();

export const SessionSpanSchema = z
  .object({ startedAt: epochMs, endedAt: epochMs })
  .refine((s) => s.endedAt >= s.startedAt, { message: 'Session must end after it starts' });
export type SessionSpan = z.infer<typeof SessionSpanSchema>;

const SessionRefSchema = z
  .object({ startedAt: epochMs, endedAt: epochMs, matterId: IdSchema.nullable() })
  .refine((s) => s.endedAt >= s.startedAt, { message: 'Session must end after it starts' });

export const ReassignSchema = z.object({ span: SessionSpanSchema, matterId: IdSchema.nullable() });
export const SplitSchema = z.object({ at: epochMs });
export const MergeSchema = z.object({
  first: SessionRefSchema,
  second: SessionRefSchema,
  matterId: IdSchema.nullable(),
});
export const NoteSchema = z.object({ span: SessionSpanSchema, note: z.string().max(2000) });
export const UpdateMatterSchema = z.object({ id: IdSchema, input: MatterInputSchema });

export const RangeSchema = z
  .object({ startMs: z.number().int(), endMs: z.number().int() })
  .refine((r) => r.endMs > r.startMs && r.endMs - r.startMs <= 2 * 24 * 3600 * 1000, {
    message: 'Range must be positive and at most 48 hours',
  });
export type Range = z.infer<typeof RangeSchema>;

// ---- Milestone 5: time entries ----

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const narrative = z.string().max(4000);

export const EntryPatchSchema = z
  .object({
    description: narrative.optional(),
    billable: z.boolean().optional(),
    /** null clears the adjustment. */
    billedOverrideMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .nullable()
      .optional(),
    overrideReason: z.string().trim().max(500).nullable().optional(),
    // Manual entries only:
    matterId: IdSchema.nullable().optional(),
    actualMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
    startAt: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type EntryPatch = z.infer<typeof EntryPatchSchema>;

export const ManualEntrySchema = z.object({
  entryDate: IsoDateSchema,
  matterId: IdSchema,
  description: narrative,
  actualMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  /** Optional start time; enables overlap checks against captured work. */
  startAt: z.number().int().nonnegative().nullable(),
  billable: z.boolean(),
});
export type ManualEntryInput = z.infer<typeof ManualEntrySchema>;

export const UpdateEntrySchema = z.object({ id: IdSchema, patch: EntryPatchSchema });
export const EntryIdsSchema = z.array(IdSchema).min(1).max(500);
