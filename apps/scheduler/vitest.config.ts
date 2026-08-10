import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig, defineProject } from 'vitest/config';

export default defineConfig(async () => {
	const migrationsPath = path.join(import.meta.dirname, '../../packages/db/migrations');
	const migrations = await readD1Migrations(migrationsPath);

	return defineProject({
		plugins: [
			cloudflareTest({
				wrangler: {
					configPath: './wrangler.test.jsonc'
				},
				miniflare: {
					bindings: { TEST_MIGRATIONS: migrations }
				}
			})
		],
		test: {
			setupFiles: ['./test/apply-migrations.ts']
		}
	});
});
