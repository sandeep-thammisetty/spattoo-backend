import 'dotenv/config';

const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'OPENAI_API_KEY',
  'REMOVE_BG_API_KEY',
  'REDIS_URL',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_URL',
];

for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

export const config = {
  supabase: {
    url:        process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  openai:   { apiKey: process.env.OPENAI_API_KEY },
  removeBg: { apiKey: process.env.REMOVE_BG_API_KEY },
  redis:    { url:    process.env.REDIS_URL },
  r2: {
    endpoint:        process.env.R2_ENDPOINT,
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket:          process.env.R2_BUCKET,
    publicUrl:       process.env.R2_PUBLIC_URL,
  },
  razorpay: {
    keyId:         process.env.RAZORPAY_KEY_ID,
    keySecret:     process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    plans: {
      // Set these in Render after creating plans in Razorpay dashboard
      flameMonthly: process.env.RAZORPAY_PLAN_FLAME_MONTHLY,
      flameYearly:  process.env.RAZORPAY_PLAN_FLAME_YEARLY,
      blazeMonthly: process.env.RAZORPAY_PLAN_BLAZE_MONTHLY,
      blazeYearly:  process.env.RAZORPAY_PLAN_BLAZE_YEARLY,
      forgeMonthly: process.env.RAZORPAY_PLAN_FORGE_MONTHLY,
      forgeYearly:  process.env.RAZORPAY_PLAN_FORGE_YEARLY,
    },
  },
  port:     parseInt(process.env.PORT || '3000', 10),
};
