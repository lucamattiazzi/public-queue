export const plans = {
  free: { id: 'free', name: 'Free', annualCents: 0, devices: 1, clients: 3, monthlyJobs: 500, dailyJobs: 50, pendingJobs: 8, storageBytes: 16 * 1024 * 1024, retentionDays: 1 },
  personal: { id: 'personal', name: 'Premium', annualCents: 2900, devices: 3, clients: 20, monthlyJobs: 10000, dailyJobs: 1000, pendingJobs: 100, storageBytes: 256 * 1024 * 1024, retentionDays: 7 },
} as const;
export const ownerPlan = { id: 'owner', name: 'Owner', annualCents: 0, devices: null, clients: null, monthlyJobs: null, dailyJobs: null, pendingJobs: null, storageBytes: null, retentionDays: null } as const;
export type Plan = typeof plans[keyof typeof plans] | typeof ownerPlan;
