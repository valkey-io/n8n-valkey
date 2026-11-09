import { Document } from '@langchain/core/documents';

import { parseCredentials } from '../nodes/ValkeyVectorStore/shared/config';
import { clearIndex } from '../nodes/ValkeyVectorStore/shared/clearIndex';
import {
	ValkeyUserError,
	classifyFtError,
	missingIndexError,
} from '../nodes/ValkeyVectorStore/shared/errors';
import { buildMetadataFilter } from '../nodes/ValkeyVectorStore/shared/filters';
import {
	assertCompatible,
	assertDimension,
	normalizeIndexInfo,
} from '../nodes/ValkeyVectorStore/shared/indexSchema';
import { validateDocumentMetadata } from '../nodes/ValkeyVectorStore/shared/insert';
import { HASH_INDEX } from './fixtures/ftInfo';

/** Runs fn and returns the ValkeyUserError it throws. */
function thrown(fn: () => unknown): ValkeyUserError {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(ValkeyUserError);
		return error as ValkeyUserError;
	}
	throw new Error('expected a ValkeyUserError, but nothing was thrown');
}

describe('ValkeyUserError codes', () => {
	it('tags a missing credential host', () => {
		expect(thrown(() => parseCredentials({})).code).toBe('invalid-credential');
	});

	it('tags an invalid filter', () => {
		const rows = [{ field: 'nope', operator: 'is', value: 'x' }];
		expect(thrown(() => buildMetadataFilter(rows as never, [], 'kb')).code).toBe('invalid-filter');
	});

	it('tags a metadata value of the wrong type', () => {
		const docs = [new Document({ pageContent: 'x', metadata: { year: 'abc' } })];
		const error = thrown(() => validateDocumentMetadata(docs, [{ name: 'year', type: 'NUMERIC' }]));
		expect(error.code).toBe('invalid-metadata');
	});

	it('tags an incompatible index and a dimension mismatch separately', () => {
		const info = normalizeIndexInfo({ ...HASH_INDEX, key_prefixes: ['doc:old:'] });
		const config = {
			indexName: 'kb',
			keyPrefix: 'doc:new:',
			vectorKey: 'content_vector',
			metadataKey: 'metadata',
			metric: 'COSINE' as const,
		};
		expect(thrown(() => assertCompatible(info, config, 'insert')).code).toBe('index-incompatible');
		expect(thrown(() => assertDimension('kb', 8, 16)).code).toBe('dimension-mismatch');
	});

	it('tags a missing index', () => {
		expect(missingIndexError('kb').code).toBe('index-not-found');
	});

	it('tags a refused delete', async () => {
		await expect(clearIndex({} as never, 'kb', [''])).rejects.toMatchObject({
			code: 'clear-index-failed',
		});
	});
});

describe('classifyFtError', () => {
	it.each([
		["Index with name 'x' not found", 'index-missing'],
		['Unknown Index name', 'index-missing'],
		["ERR unknown command 'FT.INFO'", 'search-module-missing'],
		['Index already exists', 'index-exists'],
		["NOPERM User u has no permissions to run the 'FT.INFO' command", 'other'],
		['timed out', 'other'],
	])('%s -> %s', (message, kind) => {
		expect(classifyFtError(new Error(message))).toBe(kind);
	});
});
