import { GlideClient, GlideClusterClient, InfoOptions } from '@valkey/valkey-glide';

import type { ValkeyCredentials } from './config';
import { CLUSTER_MODE_ERROR, STANDALONE_MODE_ERROR, ValkeyUserError } from './errors';

/** Fail fast instead of hanging, e.g. when TLS is required but disabled. */
export const CONNECTION_TIMEOUT_MS = 5000;
export const REQUEST_TIMEOUT_MS = 10000;

/** A connected client of either topology. */
export type ValkeyClient = GlideClient | GlideClusterClient;

/** Minimal surface of a connected client, so tests can supply a fake. */
export interface ClientFactory {
	(credentials: ValkeyCredentials): Promise<ValkeyClient>;
}

export const connectGlide: ClientFactory = async (credentials) => {
	const base = {
		addresses: [{ host: credentials.host, port: credentials.port }],
		useTLS: credentials.tls,
		credentials: credentials.password
			? { username: credentials.username, password: credentials.password }
			: undefined,
		requestTimeout: REQUEST_TIMEOUT_MS,
		advancedConfiguration: { connectionTimeout: CONNECTION_TIMEOUT_MS },
	};
	// A Valkey cluster has no logical databases, so databaseId is omitted.
	return credentials.cluster
		? await GlideClusterClient.createClient(base)
		: await GlideClient.createClient({ ...base, databaseId: credentials.database });
};

/** Returns true when an `INFO cluster` reply reports cluster mode enabled. */
export function isClusterEnabled(infoReply: string): boolean {
	return /^cluster_enabled:1\s*$/m.test(infoReply);
}

/**
 * Connects to a Valkey server with the client the credential selects, and
 * rejects a topology mismatch: a standalone credential pointed at a cluster,
 * or a cluster credential pointed at a standalone server. The caller owns the
 * returned client and must close it.
 */
export async function createValkeyClient(
	credentials: ValkeyCredentials,
	connect: ClientFactory = connectGlide,
): Promise<ValkeyClient> {
	const client = await connect(credentials);
	try {
		const info = await client.info([InfoOptions.Cluster]);
		const serverIsCluster = isClusterEnabled(infoText(info));
		if (serverIsCluster && !credentials.cluster)
			throw new ValkeyUserError(CLUSTER_MODE_ERROR, 'cluster-mode');
		if (!serverIsCluster && credentials.cluster)
			throw new ValkeyUserError(STANDALONE_MODE_ERROR, 'cluster-mode');
		return client;
	} catch (error) {
		client.close();
		throw error;
	}
}

/**
 * A standalone INFO reply is a string; a cluster client returns a per-node
 * record of replies, any of which reports the cluster state. Joins them so the
 * single `cluster_enabled:` check works for both.
 */
function infoText(info: string | Record<string, string>): string {
	return typeof info === 'string' ? info : Object.values(info).join('\n');
}
