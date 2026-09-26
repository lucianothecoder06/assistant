import { existsSync } from 'node:fs'

// Scripts run on your machine: pick up `.env.local` (what `vercel env pull` writes by default)
// and `.env`. Real environment variables win, then .env.local, then .env.
for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file)
}
