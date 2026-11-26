/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to ModelRuntime and pi-ai Models.
 */

import type {
	ApiKeyCredential,
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
	OAuthCredential,
} from "@gsd/pi-ai";
import { getOAuthProviders, type OAuthLoginCallbacks, type OAuthProviderInterface } from "@gsd/pi-ai/oauth";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { setTimeout as sleep } from "timers/promises";
import { getAgentDir } from "../config.js";
import { raceWithAbortSignal } from "../utils/abort.js";
import { getFileRevision, normalizePath } from "../utils/paths.js";
import { stripBom } from "../utils/text.js";
import { clearConfigValueCacheEntry, isCommandConfigValue, resolveConfigValue } from "./resolve-config-value.js";

/** GSD host aliases for credential shapes. */
export type { ApiKeyCredential, OAuthCredential };
export type AuthCredential = Credential;

type AuthStorageData = Record<string, Credential | Credential[]>;

function asCredentialList(entry: Credential | Credential[] | undefined): Credential[] {
	if (!entry) return [];
	return Array.isArray(entry) ? entry : [entry];
}

function primaryCredential(entry: Credential | Credential[] | undefined): Credential | undefined {
	return asCredentialList(entry)[0];
}

function resolveStoredCredential(credential: Credential): Credential {
	if (credential.type !== "api_key" || credential.key === undefined || isCommandConfigValue(credential.key)) {
		return credential;
	}
	return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
}

function isValidStoredCredential(value: unknown): value is Credential {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const credential = value as Record<string, unknown>;
	if (credential.type === "api_key") {
		const validKey = credential.key === undefined || typeof credential.key === "string";
		const validEnv =
			credential.env === undefined ||
			(typeof credential.env === "object" &&
				credential.env !== null &&
				!Array.isArray(credential.env) &&
				Object.values(credential.env).every((entry) => typeof entry === "string"));
		return validKey && validEnv;
	}
	if (credential.type === "oauth") {
		return (
			typeof credential.access === "string" &&
			typeof credential.refresh === "string" &&
			typeof credential.expires === "number" &&
			Number.isFinite(credential.expires)
		);
	}
	return false;
}

// On Windows, a just-removed lock directory can stay "delete pending" while another process
// (antivirus, indexer, another pi checking the lock) still has it open. mkdir then fails with
// EPERM until that handle closes. Retry this briefly so real permission errors still fail fast.
const MAX_EPERM_RETRIES = 5;

function getRetryableLockErrorCode(error: unknown): "ELOCKED" | "EPERM" | undefined {
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	if (code === "ELOCKED") return code;
	if (code === "EPERM" && process.platform === "win32") return code;
	return undefined;
}

type LockResult<T> = {
	result: T;
	next?: string;
};

// The mode applies only on creation so administrator-managed modes and ACLs remain intact.
const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

type AuthFileReload = {
	controller: AbortController;
	promise: Promise<AuthStorageData>;
	readers: number;
};

type AuthFileReadState = {
	data: AuthStorageData;
	revision?: string;
	reload?: AuthFileReload;
};

let sharedAuthFileReadState: { authPath: string; readState: AuthFileReadState } | undefined;

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		for (let attempt = 1; ; attempt++) {
			try {
				// Lock the resolved file so symlinked aliases of auth.json share one lock (#11655).
				return lockfile.lockSync(path);
			} catch (error) {
				if (!getRetryableLockErrorCode(error) || attempt === maxAttempts) throw error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	private async acquireLockAsync(
		signal: AbortSignal | undefined,
		onCompromised: (error: Error) => void,
	): Promise<() => Promise<void>> {
		const staleMs = 30_000;
		const maxDelayMs = 2_000;
		const deadline = Date.now() + staleMs;
		let retry = 0;
		let epermRetries = 0;
		while (true) {
			signal?.throwIfAborted();
			let release: (() => Promise<void>) | undefined;
			try {
				// Lock the resolved file so symlinked aliases of auth.json share one lock (#11655).
				release = await lockfile.lock(this.authPath, {
					retries: 0,
					stale: staleMs,
					onCompromised,
				});
			} catch (error) {
				signal?.throwIfAborted();
				const code = getRetryableLockErrorCode(error);
				const remainingMs = deadline - Date.now();
				if (!code || remainingMs <= 0) throw error;
				// The 30s deadline is for waiting on another holder; cap EPERM retries separately.
				if (code === "EPERM" && ++epermRetries > MAX_EPERM_RETRIES) throw error;
				const baseDelayMs = Math.min(10 * 2 ** retry, maxDelayMs / 2);
				retry++;
				const delayMs = Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs);
				if (signal) await sleep(delayMs, undefined, { signal });
				else await sleep(delayMs);
				continue;
			}
			if (signal?.aborted) {
				await release();
				signal.throwIfAborted();
			}
			return release;
		}
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await this.acquireLockAsync(options?.signal, (error) => {
				lockCompromised = true;
				lockCompromisedError = error;
			});

			throwIfCompromised();
			options?.signal?.throwIfAborted();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class ReadOnlyAuthStorage implements CredentialStore {
	private readonly authPath: string;
	private data: AuthStorageData | undefined;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private load(): AuthStorageData {
		if (this.data) return this.data;

		let parsed: unknown;
		try {
			parsed = JSON.parse(stripBom(readFileSync(this.authPath, "utf-8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.data = {};
				return this.data;
			}
			throw new Error(`Failed to read auth.json: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Invalid auth.json: expected an object");
		}
		for (const [providerId, credential] of Object.entries(parsed)) {
			const entries = Array.isArray(credential) ? credential : [credential];
			if (entries.length === 0 || !entries.every(isValidStoredCredential)) {
				throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
			}
		}

		this.data = parsed as AuthStorageData;
		return this.data;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const credential = primaryCredential(this.load()[providerId]);
		options?.signal?.throwIfAborted();
		if (!credential) return undefined;
		return structuredClone(resolveStoredCredential(credential));
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credentials = Object.entries(this.load()).flatMap(([providerId, entry]) =>
			asCredentialList(entry).map((credential) => ({
				providerId,
				type: credential.type,
			})),
		);
		options?.signal?.throwIfAborted();
		return credentials;
	}

	async modify(
		_providerId: string,
		_fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}

	async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private asyncChain: Promise<unknown> = Promise.resolve();

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		const previous = this.asyncChain;
		const operation = (async () => {
			await previous.catch(() => {});
			options?.signal?.throwIfAborted();
			const { result, next } = await fn(this.value);
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		})();
		this.asyncChain = operation.catch(() => {});
		return raceWithAbortSignal(operation, options?.signal);
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage implements CredentialStore {
	private storage: AuthStorageBackend;
	private authPath: string | undefined;
	private readState: AuthFileReadState;
	/** GSD: provider-level backoff for cross-provider fallback (in-memory). */
	private readonly exhaustedProviders = new Set<string>();

	private constructor(storage: AuthStorageBackend, authPath?: string) {
		this.storage = storage;
		this.authPath = authPath;
		this.readState =
			authPath && sharedAuthFileReadState?.authPath === authPath ? sharedAuthFileReadState.readState : { data: {} };
		if (authPath && !sharedAuthFileReadState) {
			sharedAuthFileReadState = { authPath, readState: this.readState };
		}
		if (authPath) {
			const revision = getFileRevision(authPath);
			if (revision !== undefined && revision === this.readState.revision) return;
		}
		this.reload();
	}

	static create(authPath: string = join(getAgentDir(), "auth.json")): AuthStorage {
		const normalizedAuthPath = normalizePath(authPath);
		return new AuthStorage(new FileAuthStorageBackend(normalizedAuthPath), normalizedAuthPath);
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(stripBom(content)) as AuthStorageData;
	}

	private updateReadState(data: AuthStorageData, revision?: string): void {
		this.readState.data = data;
		this.readState.revision = revision;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		let revision: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: undefined };
			});
			this.updateReadState(this.parseStorageData(content), revision);
		} catch {
			// Preserve the last valid in-memory snapshot.
		}
	}

	private async reloadFromStorageAsync(options?: AuthOperationOptions): Promise<AuthStorageData> {
		return this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const revision = this.authPath ? getFileRevision(this.authPath) : undefined;
			this.updateReadState(currentData, revision);
			return { result: currentData };
		}, options);
	}

	private async readLatestData(options?: AuthOperationOptions): Promise<AuthStorageData> {
		options?.signal?.throwIfAborted();
		if (!this.authPath) {
			const reload = this.reloadFromStorageAsync(options);
			return options?.signal ? reload : reload.catch(() => this.readState.data);
		}
		const revision = getFileRevision(this.authPath);
		if (revision !== undefined && revision === this.readState.revision) return this.readState.data;
		if (!this.readState.reload) {
			const controller = new AbortController();
			const reload: AuthFileReload = {
				controller,
				promise: this.reloadFromStorageAsync({ signal: controller.signal }),
				readers: 0,
			};
			this.readState.reload = reload;
			void reload.promise.then(
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
			);
		}

		const reload = this.readState.reload;
		reload.readers++;
		try {
			const result = raceWithAbortSignal(reload.promise, options?.signal);
			return options?.signal ? await result : await result.catch(() => this.readState.data);
		} finally {
			reload.readers--;
			if (reload.readers === 0 && this.readState.reload === reload) {
				this.readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const credential = primaryCredential((await this.readLatestData(options))[provider]);
		options?.signal?.throwIfAborted();
		if (!credential) return undefined;
		return resolveStoredCredential(credential);
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		let latestData = this.readState.data;
		let revision: string | undefined;
		let written: Credential | undefined;
		const result = await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const current = primaryCredential(currentData[provider]);
			const next = await fn(current);
			if (next === undefined) {
				latestData = currentData;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: current };
			}

			const merged: AuthStorageData = { ...currentData, [provider]: next };
			latestData = merged;
			written = next;
			return { result: next, next: JSON.stringify(merged, null, 2) };
		}, options);
		this.updateReadState(latestData, revision);
		// Command results are cached for the process. Saving a `!command` key, even the same one, runs it
		// again, so signing in to a secrets manager and saving the key again recovers from a failure.
		if (written?.type === "api_key" && written.key) clearConfigValueCacheEntry(written.key);
		return result;
	}

	async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		let latestData = this.readState.data;
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			delete currentData[provider];
			latestData = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		}, options);
		this.updateReadState(latestData);
	}

	/** GSD: mark a provider unavailable after quota/rate exhaustion. */
	markProviderExhausted(provider: string, _errorType?: string): void {
		this.exhaustedProviders.add(provider);
	}

	/** GSD: whether fallback routing may use this provider. */
	isProviderAvailable(provider: string): boolean {
		return !this.exhaustedProviders.has(provider);
	}

	/** List credential metadata without resolving configured key values. */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = Object.entries(await this.readLatestData(options));
		options?.signal?.throwIfAborted();
		return entries.flatMap(([providerId, entry]) =>
			asCredentialList(entry).map((credential) => ({ providerId, type: credential.type })),
		);
	}

	/** GSD: sync credential listing from the in-memory cache. */
	listSync(): readonly CredentialInfo[] {
		return Object.entries(this.readState.data).flatMap(([providerId, entry]) =>
			asCredentialList(entry).map((credential) => ({
				providerId,
				type: credential.type,
			})),
		);
	}

	/** GSD: sync provider ids with stored credentials (main-compat `list()`). */
	listProviders(): string[] {
		return Object.keys(this.readState.data);
	}

	/** GSD host synchronous credential read from the in-memory cache. */
	get(provider: string): Credential | undefined {
		return this.getCredentialsForProvider(provider)[0];
	}

	/** GSD host synchronous credential removal. */
	remove(provider: string): void {
		this.storage.withLock((current) => {
			const currentData = this.parseStorageData(current);
			delete currentData[provider];
			this.updateReadState(currentData, this.authPath ? getFileRevision(this.authPath) : undefined);
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		});
	}

	hasAuth(provider: string): boolean {
		return this.get(provider) !== undefined;
	}

	set(provider: string, credential: Credential): void {
		const merged: AuthStorageData = { ...this.readState.data, [provider]: credential };
		this.updateReadState(merged, this.readState.revision);
		if (credential.type === "api_key" && credential.key) {
			clearConfigValueCacheEntry(credential.key);
		}
		void this.modify(provider, async () => credential);
	}

	setRuntimeApiKey(provider: string, apiKey: string): void {
		void this.modify(provider, async () => ({ type: "api_key", key: apiKey }));
	}

	getOAuthProviders(): OAuthProviderInterface[] {
		return getOAuthProviders();
	}

	async login(_providerId: string, _callbacks?: OAuthLoginCallbacks): Promise<void> {
		throw new Error("OAuth login is handled through ModelRuntime in pi v1.6.1");
	}

	async logout(providerId: string): Promise<void> {
		await this.delete(providerId);
	}
	/** GSD: credentials for a provider (supports round-robin multi-key entries). */
	getCredentialsForProvider(provider: string): Credential[] {
		return asCredentialList(this.readState.data[provider]);
	}

	/** GSD: alias for hasAuth. */
	has(provider: string): boolean {
		return this.hasAuth(provider);
	}

	/** GSD: whether every credential for the provider is in backoff. */
	areAllCredentialsBackedOff(provider: string): boolean {
		return !this.isProviderAvailable(provider);
	}

	/** GSD: remaining backoff ms (0 when available). */
	getProviderBackoffRemaining(provider: string): number {
		return this.isProviderAvailable(provider) ? 0 : 60_000;
	}

	/** GSD: resolve a usable API key without OAuth refresh. */
	async getApiKey(providerId: string, _options?: { includeFallback?: boolean }): Promise<string | undefined> {
		const cred = this.get(providerId);
		if (!cred) return undefined;
		if (cred.type === "api_key") return cred.key;
		return undefined;
	}
}


/**
 * One-off synchronous read of a stored credential from an auth.json file,
 * without instantiating a store or resolving configured key values.
 */
export function readStoredCredential(
	providerId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
): Credential | undefined {
	try {
		const data = JSON.parse(stripBom(readFileSync(normalizePath(authPath), "utf-8"))) as AuthStorageData;
		return primaryCredential(data[providerId]);
	} catch {
		return undefined;
	}
}
