/** Short, stable tag for the kind of problem, so tests need not match on message text. */
export type ValkeyErrorCode =
	| 'invalid-parameter'
	| 'invalid-credential'
	| 'invalid-filter'
	| 'invalid-metadata'
	| 'embeddings-response'
	| 'index-not-found'
	| 'index-incompatible'
	| 'dimension-mismatch'
	| 'search-module-missing'
	| 'cluster-mode'
	| 'clear-index-failed'
	| 'partial-write'
	| 'invalid-id';

/**
 * Error raised for conditions the user can fix (incompatible index, invalid
 * filter, bad metadata, unsupported server). The node layer turns these into
 * NodeOperationErrors; the message is always shown to the user.
 */
export class ValkeyUserError extends Error {
	constructor(
		message: string,
		readonly code: ValkeyErrorCode,
	) {
		super(message);
		this.name = 'ValkeyUserError';
	}
}

export const SEARCH_MODULE_MISSING =
	'The ValkeySearch module is not available on this server. Use Valkey 8.2+ with ValkeySearch loaded, for example the valkey/valkey-bundle image or ElastiCache for Valkey.';

export const CLUSTER_MODE_ERROR =
	'Cluster mode is not supported. This node only supports standalone Valkey (ElastiCache cluster mode disabled).';

export const NO_DOCUMENTS_ERROR =
	'No documents to insert: the connected Document Loader produced no documents.';

export function missingIndexError(indexName: string): ValkeyUserError {
	return new ValkeyUserError(
		`Index "${indexName}" does not exist. Check the index name, or insert documents first.`,
		'index-not-found',
	);
}

export type FtErrorKind = 'index-missing' | 'search-module-missing' | 'index-exists' | 'other';

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Classifies an error returned by an FT.* command.
 *
 * Only the "index not found" and "unknown command" replies are interpreted.
 * Anything else (timeouts, NOAUTH, ACL denials, OOM) is 'other' and must be
 * reported unchanged.
 */
export function classifyFtError(error: unknown): FtErrorKind {
	const message = messageOf(error).toLowerCase();
	if (message.includes('unknown command')) return 'search-module-missing';
	if (message.includes('already exists')) return 'index-exists';
	if (
		message.includes('not found') ||
		message.includes('unknown index') ||
		message.includes('no such index')
	) {
		return 'index-missing';
	}
	return 'other';
}

export { messageOf };
