import { GlideClient, InfoOptions } from '@valkey/valkey-glide';

import type { ValkeyCredentials } from './config';
import { CLUSTER_MODE_ERROR, ValkeyUserError } from './errors';

/** Fail fast instead of hanging, e.g. when TLS is required but disabled. */
export const CONNECTION_TIMEOUT_MS = 5000;
export const REQUEST_TIMEOUT_MS = 10000;

/** Minimal surface of a connected client, so tests can supply a fake. */
export interface ClientFactory {
	(credentials: ValkeyCredentials): Promise<GlideClient>;
}

export const connectGlide: ClientFactory = async (credentials) => {
	return await GlideClient.createClient({
		addresses: [{ host: credentials.host, port: credentials.port }],
		useTLS: credentials.tls,
		credentials: credentials.password
			? { username: credentials.username, password: credentials.password }
			: undefined,
		databaseId: credentials.database,
		requestTimeout: REQUEST_TIMEOUT_MS,
		advancedConfiguration: { connectionTimeout: CONNECTION_TIMEOUT_MS },
	});
};

/** Returns true when an `INFO cluster` reply reports cluster mode enabled. */
export function isClusterEnabled(infoReply: string): boolean {
	return /^cluster_enabled:1\s*$/m.test(infoReply);
}

/**
 * Connects to a standalone Valkey server and rejects cluster-mode servers.
 * The caller owns the returned client and must close it.
 */
export async function createValkeyClient(
	credentials: ValkeyCredentials,
	connect: ClientFactory = connectGlide,
): Promise<GlideClient> {
	const client = await connect(credentials);
	try {
		const info = await client.info([InfoOptions.Cluster]);
		if (isClusterEnabled(info)) throw new ValkeyUserError(CLUSTER_MODE_ERROR, 'cluster-mode');
		return client;
	} catch (error) {
		client.close();
		throw error;
	}
}
