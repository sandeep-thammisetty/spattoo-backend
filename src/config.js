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
  port:     parseInt(process.env.PORT || '3000', 10),
};
