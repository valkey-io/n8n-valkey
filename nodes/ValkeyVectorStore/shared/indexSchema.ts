import { GlideFt } from '@valkey/valkey-glide';
import type { FtInfoReturnType, GlideClient } from '@valkey/valkey-glide';

import { SEARCH_MODULE_MISSING, ValkeyUserError, classifyFtError } from './errors';

export const DISTANCE_METRICS = ['COSINE', 'L2', 'IP'] as const;
export type DistanceMetric = (typeof DISTANCE_METRICS)[number];

export function isDistanceMetric(value: string): value is DistanceMetric {
	return (DISTANCE_METRICS as readonly string[]).includes(value);
}
export type MetadataFieldType = 'TAG' | 'NUMERIC';

export interface IndexField {
	/** Hash field the index reads, e.g. `metadata_source` or `content_vector`. */
	identifier: string;
	/** Name queries use for the field (its alias), e.g. `metadata_source`. Same as identifier when the index sets none. */
	attribute: string;
	type: string;
	/** TAG only: the character the index splits values on, when it is not the default `,`. */
	separator?: string;
	/** TAG only: true when the index was created with CASESENSITIVE. */
	caseSensitive?: boolean;
}

export interface IndexVectorField {
	/** Hash field that holds the vector. */
	name: string;
	/** Name KNN queries use for the field. */
	attribute: string;
	dim: number;
	metric: string;
	algorithm: string;
}

/** Normalized FT.INFO reply. */
export interface IndexInfo {
	name: string;
	dataType: string;
	prefixes: string[];
	vectors: IndexVectorField[];
	fields: IndexField[];
}

export interface MetadataField {
	name: string;
	type: MetadataFieldType;
	/** TAG only, from an existing index: its separator when it is not `,`. */
	separator?: string;
	/** TAG only, from an existing index created with CASESENSITIVE. */
	caseSensitive?: boolean;
}

type Raw = unknown;

function str(value: Raw): string {
	if (value === undefined || value === null) return '';
	if (Buffer.isBuffer(value)) return value.toString('utf8');
	return String(value);
}

function isKey(value: Raw): boolean {
	return typeof value === 'string' || Buffer.isBuffer(value);
}

/**
 * Accepts either an object or the flat `[key, value, key, value, ...]` arrays
 * that ValkeySearch returns for `index_definition`, each attribute and the
 * vector `index` / `algorithm` blocks (Glide passes those through unchanged).
 */
function asRecord(value: Raw): Record<string, Raw> | undefined {
	if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return undefined;
	if (!Array.isArray(value)) return value as Record<string, Raw>;
	if (value.length === 0 || value.length % 2 !== 0) return undefined;
	const record: Record<string, Raw> = {};
	for (let i = 0; i < value.length; i += 2) {
		if (!isKey(value[i])) return undefined;
		record[str(value[i])] = value[i + 1];
	}
	return record;
}

/** Attribute options that some ValkeySearch versions send without a value. */
const BARE_FLAGS = new Set(['CASESENSITIVE']);

function isFlagValue(value: Raw): boolean {
	return value === 0 || value === 1 || value === '0' || value === '1';
}

/**
 * Like asRecord, for one attribute entry. Older ValkeySearch versions send
 * CASESENSITIVE as a bare flag (`..., "CASESENSITIVE", "size", "0"`); newer
 * ones send `"CASESENSITIVE", "1"`. A bare flag is read as `'1'`, so an
 * odd-length entry is not rejected and the field is not dropped.
 */
function asAttributeRecord(value: Raw): Record<string, Raw> | undefined {
	if (!Array.isArray(value)) return asRecord(value);
	const record: Record<string, Raw> = {};
	for (let i = 0; i < value.length; ) {
		if (!isKey(value[i])) return undefined;
		const key = str(value[i]);
		if (BARE_FLAGS.has(key.toUpperCase()) && !isFlagValue(value[i + 1])) {
			record[key] = '1';
			i += 1;
			continue;
		}
		if (i + 1 >= value.length) return undefined;
		record[key] = value[i + 1];
		i += 2;
	}
	return record;
}

/** Case-insensitive lookup across the key spellings used by ValkeySearch and Glide. */
function pick(record: Record<string, Raw> | undefined, ...keys: string[]): Raw {
	if (!record) return undefined;
	for (const key of keys) {
		if (key in record) return record[key];
	}
	const lower = Object.fromEntries(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
	for (const key of keys) {
		if (key.toLowerCase() in lower) return lower[key.toLowerCase()];
	}
	return undefined;
}

/**
 * Normalizes a GlideFt.info reply. The reply shape differs between
 * ValkeySearch and Glide versions, so several spellings are accepted; the
 * fixtures in the tests pin the shapes we have seen.
 */
export function normalizeIndexInfo(raw: FtInfoReturnType | Record<string, Raw>): IndexInfo {
	const record = raw as Record<string, Raw>;
	const definition = asRecord(pick(record, 'index_definition'));

	const dataType = str(pick(record, 'key_type') ?? pick(definition, 'key_type')).toUpperCase();
	const prefixesRaw = pick(record, 'key_prefixes') ?? pick(definition, 'prefixes');
	const prefixes = Array.isArray(prefixesRaw)
		? prefixesRaw.map(str)
		: prefixesRaw
			? [str(prefixesRaw)]
			: [];

	const fieldsRaw = pick(record, 'fields', 'attributes');
	const vectors: IndexVectorField[] = [];
	const fields: IndexField[] = [];

	if (Array.isArray(fieldsRaw)) {
		for (const entry of fieldsRaw) {
			const field = asAttributeRecord(entry);
			if (!field) continue;
			const identifier = str(pick(field, 'identifier', 'field_name', 'attribute'));
			// ValkeySearch sends the alias as `attribute`; Glide's documented shape calls it `field_name`.
			const attribute = str(pick(field, 'attribute', 'field_name')) || identifier;
			const type = str(pick(field, 'type')).toUpperCase();
			const parsed: IndexField = { identifier, attribute, type };
			if (type === 'TAG') {
				const separator = str(pick(field, 'SEPARATOR'));
				if (separator && separator !== ',') parsed.separator = separator;
				const caseSensitive = str(pick(field, 'CASESENSITIVE')).toLowerCase();
				if (caseSensitive === '1' || caseSensitive === 'true') parsed.caseSensitive = true;
			}
			fields.push(parsed);
			if (type === 'VECTOR') {
				const params =
					asRecord(pick(field, 'vector_params')) ?? asRecord(pick(field, 'index')) ?? field;
				const algorithmRaw = pick(params, 'algorithm');
				const algorithm = asRecord(algorithmRaw)
					? pick(asRecord(algorithmRaw), 'name')
					: algorithmRaw;
				vectors.push({
					name: identifier,
					attribute,
					dim: Number(pick(params, 'dimension', 'dimensions', 'dim')),
					metric: str(pick(params, 'distance_metric', 'distance')).toUpperCase(),
					algorithm: str(algorithm).toUpperCase(),
				});
			}
		}
	}

	return { name: str(pick(record, 'index_name')), dataType, prefixes, vectors, fields };
}

/**
 * TAG and NUMERIC fields stored in the hash field `<metadataKey>_<name>`, the
 * name the library writes and queries. TAG fields keep the index's separator
 * and CASESENSITIVE setting, so writes match the index. Selected by hash
 * field, so a field queried under another name is returned too;
 * assertCompatible rejects such an index.
 */
export function metadataFields(info: IndexInfo, metadataKey: string): MetadataField[] {
	const prefix = `${metadataKey}_`;
	const result: MetadataField[] = [];
	for (const field of info.fields) {
		if (!field.identifier.startsWith(prefix)) continue;
		if (field.type !== 'TAG' && field.type !== 'NUMERIC') continue;
		const metadata: MetadataField = {
			name: field.identifier.slice(prefix.length),
			type: field.type,
		};
		if (field.separator) metadata.separator = field.separator;
		if (field.caseSensitive) metadata.caseSensitive = true;
		result.push(metadata);
	}
	return result;
}

export type FtInfoFn = (client: GlideClient, indexName: string) => Promise<FtInfoReturnType>;

const defaultFtInfo: FtInfoFn = async (client, indexName) => await GlideFt.info(client, indexName);

/**
 * Reads and normalizes FT.INFO for an index.
 *
 * Returns null only when the server says the index does not exist. A server
 * without ValkeySearch gets a clear error; every other failure (timeout,
 * NOAUTH, ACL denial) is rethrown unchanged so it is never mistaken for a
 * missing index.
 */
export async function readIndexInfo(
	client: GlideClient,
	indexName: string,
	ftInfo: FtInfoFn = defaultFtInfo,
): Promise<IndexInfo | null> {
	try {
		return normalizeIndexInfo(await ftInfo(client, indexName));
	} catch (error) {
		const kind = classifyFtError(error);
		if (kind === 'index-missing') return null;
		if (kind === 'search-module-missing')
			throw new ValkeyUserError(SEARCH_MODULE_MISSING, 'search-module-missing');
		throw error;
	}
}

export interface CompatibilityConfig {
	indexName: string;
	keyPrefix: string;
	vectorKey: string;
	metadataKey: string;
	metric: DistanceMetric;
	/** Embedding dimension, when known. */
	dimension?: number;
	/** Insert only: metadata fields the user declared. */
	declaredFields?: MetadataField[];
}

const RECREATE_HINT =
	'The schema of an existing index cannot be changed: enable Delete Index and Documents to recreate it, or use a new index name and key prefix.';

/**
 * Throws a ValkeyUserError describing the first incompatibility between an
 * existing index and the node's configuration. Never logs and continues.
 */
export function assertCompatible(
	info: IndexInfo,
	config: CompatibilityConfig,
	mode: 'insert' | 'retrieve',
): void {
	const idx = `Index "${config.indexName}"`;

	if (info.dataType !== 'HASH') {
		if (info.dataType === 'JSON') {
			throw new ValkeyUserError(
				`${idx} uses JSON storage. This node supports only HASH indexes. ${RECREATE_HINT}`,
				'index-incompatible',
			);
		}
		throw new ValkeyUserError(
			`${idx} uses ${info.dataType || 'an unknown'} storage. This node supports only HASH indexes.`,
			'index-incompatible',
		);
	}

	if (!info.prefixes.includes(config.keyPrefix)) {
		throw new ValkeyUserError(
			`${idx} covers key prefix ${info.prefixes.map((p) => `"${p}"`).join(', ') || '(none)'}, not the configured key prefix "${config.keyPrefix}". Set Key Prefix to match the index.`,
			'index-incompatible',
		);
	}

	const vector = info.vectors.find((v) => v.name === config.vectorKey);
	if (!vector) {
		const found = info.vectors.map((v) => `"${v.name}"`).join(', ') || 'none';
		throw new ValkeyUserError(
			`${idx} has no VECTOR field named "${config.vectorKey}" (vector fields found: ${found}). Set Vector Key to match the index.`,
			'index-incompatible',
		);
	}

	// Searches address fields by attribute name, so an alias the node does not
	// expect makes every query fail on the server.
	if (vector.attribute !== config.vectorKey) {
		throw new ValkeyUserError(
			`${idx} names its VECTOR field "${config.vectorKey}" "${vector.attribute}" in queries, but the node queries it as "${config.vectorKey}". Recreate the index without an alias for the vector field.`,
			'index-incompatible',
		);
	}

	// The library writes each metadata value to the hash field
	// `<metadataKey>_<name>` and queries the index attribute of the same name,
	// so every metadata field must use that one name, with no alias.
	const metadataPrefix = `${config.metadataKey}_`;
	const earlierLayoutPrefix = `${config.metadataKey}.`;
	for (const field of info.fields) {
		if (field.type !== 'TAG' && field.type !== 'NUMERIC') continue;
		if (field.identifier.startsWith(earlierLayoutPrefix)) {
			const name = field.identifier.slice(earlierLayoutPrefix.length);
			throw new ValkeyUserError(
				`${idx} reads metadata field "${name}" from the hash field "${field.identifier}", which an earlier version of this node wrote. This version writes "${metadataPrefix}${name}", so documents inserted now would not match filters. ${RECREATE_HINT}`,
				'index-incompatible',
			);
		}
		if (field.identifier.startsWith(metadataPrefix) && field.attribute !== field.identifier) {
			throw new ValkeyUserError(
				`${idx} names metadata field "${field.identifier}" "${field.attribute}" in queries, but the node queries it as "${field.identifier}". ${RECREATE_HINT}`,
				'index-incompatible',
			);
		}
		if (field.attribute.startsWith(metadataPrefix) && field.identifier !== field.attribute) {
			throw new ValkeyUserError(
				`${idx} reads metadata field "${field.attribute}" from the hash field "${field.identifier}", but the node writes it to "${field.attribute}". ${RECREATE_HINT}`,
				'index-incompatible',
			);
		}
	}

	if (vector.metric && vector.metric !== config.metric) {
		throw new ValkeyUserError(
			`${idx} uses distance metric ${vector.metric}, but the node is configured for ${config.metric}. Set Distance Metric to ${vector.metric}, or recreate the index.`,
			'index-incompatible',
		);
	}

	if (config.dimension !== undefined) {
		assertDimension(config.indexName, vector.dim, config.dimension);
	}

	if (mode === 'insert' && config.declaredFields) {
		const indexed = new Map(metadataFields(info, config.metadataKey).map((f) => [f.name, f.type]));
		for (const declared of config.declaredFields) {
			const actual = indexed.get(declared.name);
			if (!actual) {
				throw new ValkeyUserError(
					`${idx} has no indexed metadata field "${declared.name}". ${RECREATE_HINT}`,
					'index-incompatible',
				);
			}
			if (actual !== declared.type) {
				throw new ValkeyUserError(
					`Metadata field "${declared.name}" is indexed as ${actual} in ${idx}, but declared as ${declared.type}. ${RECREATE_HINT}`,
					'index-incompatible',
				);
			}
		}
	}
}

export function assertDimension(indexName: string, indexDim: number, embeddingDim: number): void {
	if (Number.isFinite(indexDim) && indexDim !== embeddingDim) {
		throw new ValkeyUserError(
			`Index "${indexName}" has vector dimension ${indexDim}, but the connected embeddings produce ${embeddingDim}. Use the embeddings model the index was built with, or recreate the index.`,
			'dimension-mismatch',
		);
	}
}
