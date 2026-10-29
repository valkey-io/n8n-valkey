import { GlideFt } from '@valkey/valkey-glide';
import type { GlideClient } from '@valkey/valkey-glide';

import { SEARCH_MODULE_MISSING, ValkeyUserError, classifyFtError, messageOf } from './errors';

/** Escapes glob metacharacters so SCAN MATCH treats the prefix literally. */
export function escapeGlob(value: string): string {
	return value.replace(/[*?[\]\\]/g, '\\$&');
}

export const SCAN_COUNT = 1000;

/** The subset of GlideClient used here, so tests can pass a fake. */
export type ClearIndexClient = Pick<GlideClient, 'scan' | 'unlink'>;

export type DropIndexFn = (client: ClearIndexClient, indexName: string) => Promise<unknown>;

const defaultDropIndex: DropIndexFn = async (client, indexName) =>
	await GlideFt.dropindex(client as GlideClient, indexName);

/** Running count of confirmed deletions; a lost response can leave more keys deleted. */
interface DeleteProgress {
	deleted: number;
}

async function scanAndUnlink(
	client: ClearIndexClient,
	prefix: string,
	progress: DeleteProgress,
): Promise<void> {
	const match = `${escapeGlob(prefix)}*`;
	let cursor = '0';
	do {
		const [next, keys] = await client.scan(cursor, { match, count: SCAN_COUNT });
		cursor = String(next);
		if (keys.length > 0) progress.deleted += await client.unlink(keys);
	} while (cursor !== '0');
}

/** The server's message without trailing punctuation, so it can sit inside a sentence. */
function reason(error: unknown): string {
	return messageOf(error)
		.trim()
		.replace(/[\s.:;,]+$/, '');
}

function failure(message: string, cause: unknown): ValkeyUserError {
	const error = new ValkeyUserError(message, 'clear-index-failed');
	error.cause = cause;
	return error;
}

/**
 * Deletes every key under the given key prefixes, in batches, and then drops
 * the index. The documents go first on purpose: the index is the only record
 * of which prefixes hold its documents, so while it exists a failed run can be
 * repeated and will find the rest. The library's delete({ deleteAll }) only
 * drops the index, which leaves the documents behind to be re-indexed by the
 * next FT.CREATE.
 *
 * The delete is deliberately not atomic. On Valkey 8.2, a MULTI/EXEC
 * transaction that deletes the document keys and runs FT.DROPINDEX together
 * freezes the server, so the keys are removed in SCAN + UNLINK batches and the
 * index is dropped afterwards as a separate command.
 *
 * @returns the number of keys deleted
 */
export async function clearIndex(
	client: ClearIndexClient,
	indexName: string,
	keyPrefixes: string[],
	dropIndex: DropIndexFn = defaultDropIndex,
): Promise<number> {
	if (keyPrefixes.length === 0 || keyPrefixes.some((prefix) => !prefix)) {
		// An empty prefix would match every key in the database.
		throw new ValkeyUserError(
			'Delete Index and Documents needs a non-empty key prefix; an empty prefix would delete every key in the database.',
			'clear-index-failed',
		);
	}

	const progress: DeleteProgress = { deleted: 0 };
	try {
		for (const prefix of keyPrefixes) {
			await scanAndUnlink(client, prefix, progress);
		}
	} catch (error) {
		throw failure(
			`Could not delete all documents of index "${indexName}": ${reason(error)}. ` +
				`${progress.deleted} key(s) were confirmed deleted; additional keys may have been deleted if a command response was lost. ` +
				'The index was not dropped. Run the node again to finish deleting.',
			error,
		);
	}

	try {
		await dropIndex(client, indexName);
	} catch (error) {
		const kind = classifyFtError(error);
		if (kind === 'search-module-missing')
			throw new ValkeyUserError(SEARCH_MODULE_MISSING, 'search-module-missing');
		if (kind !== 'index-missing') {
			throw failure(
				`All ${progress.deleted} document key(s) of index "${indexName}" were deleted, but the index could not be dropped: ${reason(error)}. ` +
					'Run the node again to finish.',
				error,
			);
		}
	}
	return progress.deleted;
}
