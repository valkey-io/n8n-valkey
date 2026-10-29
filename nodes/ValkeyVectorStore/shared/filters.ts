import { SchemaFieldTypes } from '@langchain/valkey';
import type { CustomSchemaField } from '@langchain/valkey';

import { ValkeyUserError } from './errors';
import type { MetadataField, MetadataFieldType } from './indexSchema';

export const TAG_OPERATORS = ['is', 'isAnyOf'] as const;
export const NUMERIC_OPERATORS = ['equals', 'gte', 'lte', 'between'] as const;

export type TagOperator = (typeof TAG_OPERATORS)[number];
export type NumericOperator = (typeof NUMERIC_OPERATORS)[number];

export const DEFAULT_TAG_OPERATOR: TagOperator = 'is';
export const DEFAULT_NUMERIC_OPERATOR: NumericOperator = 'gte';

/** One row of the Metadata Filter list, as returned by getNodeParameter. */
export interface FilterConditionRow {
	field?: unknown;
	fieldType?: unknown;
	tagOperator?: unknown;
	numericOperator?: unknown;
	value?: unknown;
	valueTo?: unknown;
}

export type NumericRange = { min?: number; max?: number };
export type MetadataFilter = Record<string, string | string[] | NumericRange>;

/** Separator between field name and type in the Field dropdown's option values. */
export const FIELD_TYPE_SEPARATOR = '|';

export function encodeFieldOption(field: MetadataField): string {
	return `${field.name}${FIELD_TYPE_SEPARATOR}${field.type}`;
}

/** Accepts both `source|TAG` (picked from the list) and `source` (typed or from an expression). */
export function decodeFieldName(value: unknown): string {
	const text = String(value ?? '').trim();
	const separator = text.lastIndexOf(FIELD_TYPE_SEPARATOR);
	return separator === -1 ? text : text.slice(0, separator).trim();
}

/**
 * customSchema for the library, built from the index's own TAG/NUMERIC fields.
 * A TAG field's separator decides how the library joins array values.
 */
export function toCustomSchema(fields: MetadataField[]): Record<string, CustomSchemaField> {
	const schema: Record<string, CustomSchemaField> = {};
	for (const field of fields) {
		if (field.type !== 'TAG') {
			schema[field.name] = { type: SchemaFieldTypes.NUMERIC };
			continue;
		}
		const tag: CustomSchemaField = { type: SchemaFieldTypes.TAG };
		if (field.separator !== undefined) tag.SEPARATOR = field.separator;
		if (field.caseSensitive) tag.CASESENSITIVE = true;
		schema[field.name] = tag;
	}
	return schema;
}

function parseNumber(label: string, value: unknown): number {
	const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
	const number = Number(text);
	if (text === '' || !Number.isFinite(number)) {
		throw new ValkeyUserError(
			`${label}: the value must be a number, got "${String(value ?? '')}".`,
			'invalid-filter',
		);
	}
	return number;
}

function parseTagValues(label: string, value: unknown, many: boolean): string[] {
	let values: string[];
	if (Array.isArray(value)) {
		values = value.map((v) => String(v).trim());
	} else {
		const text = String(value ?? '');
		values = many ? text.split(',').map((v) => v.trim()) : [text.trim()];
	}
	values = values.filter((v) => v !== '');
	if (values.length === 0)
		throw new ValkeyUserError(`${label}: the value is empty.`, 'invalid-filter');
	return values;
}

/**
 * Validates the Metadata Filter rows against the index's TAG/NUMERIC fields and
 * converts them to the library's metadataFilter. Conditions are ANDed.
 *
 * Validation uses the index's real field types, so fields and operators
 * supplied by expressions are checked as well.
 */
export function buildMetadataFilter(
	rows: FilterConditionRow[],
	indexFields: MetadataField[],
	indexName: string,
): MetadataFilter | undefined {
	if (rows.length === 0) return undefined;

	const types = new Map<string, MetadataFieldType>(indexFields.map((f) => [f.name, f.type]));
	const filter: MetadataFilter = {};

	rows.forEach((row, index) => {
		const name = decodeFieldName(row.field);
		const label = `Metadata Filter condition ${index + 1}${name ? ` ("${name}")` : ''}`;

		if (!name) throw new ValkeyUserError(`${label}: no field selected.`, 'invalid-filter');

		const type = types.get(name);
		if (!type) {
			throw new ValkeyUserError(
				`${label}: "${name}" is not an indexed field of index "${indexName}". Filterable fields: ${
					indexFields.map((f) => `"${f.name}"`).join(', ') || 'none'
				}.`,
				'invalid-filter',
			);
		}

		if (type === 'TAG') {
			const operator = String(row.tagOperator ?? DEFAULT_TAG_OPERATOR);
			if (!(TAG_OPERATORS as readonly string[]).includes(operator)) {
				throw new ValkeyUserError(
					`${label}: operator "${operator}" is not valid for TAG field "${name}". Use "is" or "is any of".`,
					'invalid-filter',
				);
			}
			if (name in filter) {
				throw new ValkeyUserError(
					`${label}: field "${name}" already has a condition. Combine the values into one "is any of" condition.`,
					'invalid-filter',
				);
			}
			const values = parseTagValues(label, row.value, operator === 'isAnyOf');
			filter[name] = operator === 'is' && values.length === 1 ? values[0] : values;
			return;
		}

		const operator = String(row.numericOperator ?? DEFAULT_NUMERIC_OPERATOR);
		if (!(NUMERIC_OPERATORS as readonly string[]).includes(operator)) {
			throw new ValkeyUserError(
				`${label}: operator "${operator}" is not valid for NUMERIC field "${name}". Use "equals", "greater than or equal", "less than or equal" or "between".`,
				'invalid-filter',
			);
		}

		let range: NumericRange;
		if (operator === 'equals') {
			const n = parseNumber(label, row.value);
			range = { min: n, max: n };
		} else if (operator === 'gte') {
			range = { min: parseNumber(label, row.value) };
		} else if (operator === 'lte') {
			range = { max: parseNumber(label, row.value) };
		} else {
			range = { min: parseNumber(label, row.value), max: parseNumber(label, row.valueTo) };
		}

		// Several conditions on one NUMERIC field (e.g. >= 2020 and <= 2024) intersect.
		const existing = filter[name] as NumericRange | undefined;
		const merged: NumericRange = { ...existing };
		if (range.min !== undefined)
			merged.min = merged.min === undefined ? range.min : Math.max(merged.min, range.min);
		if (range.max !== undefined)
			merged.max = merged.max === undefined ? range.max : Math.min(merged.max, range.max);
		if (merged.min !== undefined && merged.max !== undefined && merged.min > merged.max) {
			throw new ValkeyUserError(
				`${label}: the conditions on "${name}" can never match (minimum ${merged.min} is greater than maximum ${merged.max}).`,
				'invalid-filter',
			);
		}
		filter[name] = merged;
	});

	return filter;
}
