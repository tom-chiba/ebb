/// <reference path="../worker-configuration.d.ts" />

import type { Auth } from '$lib/server/auth';

type SessionShape = Auth['$Infer']['Session'];

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: SessionShape['user'] | null;
			session: SessionShape['session'] | null;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: Env;
		}
	}
}

export {};
