# Deploy your own instance

1. Install dependencies with `npm ci` and authenticate using `npx wrangler login`.
2. Enable Cloudflare R2. Create a D1 database (`npx wrangler d1 create my5tb`) and R2 bucket (`npx wrangler r2 bucket create my5tb-previews`). Set your database ID and bucket in `cloud/wrangler.jsonc`.
3. Set `SITE_ORIGIN` to your own Pages origin. Keep Worker service names consistent with `web/wrangler.jsonc` and `cloud/site.wrangler.jsonc`.
4. Apply schema: `npx wrangler d1 migrations apply my5tb --remote --config cloud/wrangler.jsonc`.
5. Set Worker secrets `ADMIN_TOKEN` (strong random token, at least 32 characters) and `PREVIEW_KEY_B64` (base64 of 32 random bytes), using `npx wrangler secret put NAME --config cloud/wrangler.jsonc`. Keep independent secure backups. Never commit these values.
6. Deploy API: `npm run deploy:api`. Build: `npm run build`. Create a Pages project named `my5tb-web` or change the deploy script/config to your project name. Run `npm run deploy:web`.
7. Confirm Pages has the `API` service binding to your API Worker. Verify catalog, previews and admin access on your origin. `cloud/site.wrangler.jsonc` provides an optional Worker-assets deployment alternative.

For production ingestion, configure Google OAuth for your storage account using `scripts/setup_drive.py`, then use the generated private config with `scripts/Start-Desktop.ps1 -Config PATH`. Adapt the script's site URL and collection root to your instance before running it. Model files must be shared appropriately for public downloads. Images and manifests remain in Cloudflare storage.

Customize the contact email in `web/src/community.ts` and replace bundled artwork with assets you have permission to use. Review submission quotas, retention and provider billing before accepting public uploads. Secrets, generated configs, OAuth files, journals and logs belong outside source control.
