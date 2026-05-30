export const SUBSCRIPTION_STATUS = {
  ACTIVE:    1,
  PENDING:   2,
  PAUSED:    3,
  PAST_DUE:  4,
  EXPIRED:   5,
  CANCELLED: 6,
  ID_BY_NAME: { active: 1, pending: 2, paused: 3, past_due: 4, expired: 5, cancelled: 6 },
  NAME_BY_ID: { 1: 'active', 2: 'pending', 3: 'paused', 4: 'past_due', 5: 'expired', 6: 'cancelled' },
};
