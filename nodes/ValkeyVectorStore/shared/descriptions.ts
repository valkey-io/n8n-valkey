import type { INodeProperties } from 'n8n-workflow';

/** Shown in every mode, above n8n's own fields (Prompt, Limit, ID). */
export const sharedFields: INodeProperties[] = [
	{
		displayName: 'Valkey Index',
		name: 'valkeyIndex',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. my-docs',
		description: 'Name of the search index. Insert creates it if it does not exist.',
	},
];

/**
 * Settings of the index itself, so they must match in every mode. Defined
 * once and listed first in each mode's fields, not in sharedFields, so that
 * n8n places it below its own Prompt, Limit and ID fields. n8n copies each
 * listed field and sets the copy's mode, so the one name (and its stored
 * value) is shared by all modes.
 */
const indexOptionsField: INodeProperties = {
	displayName: 'Index Options',
	name: 'indexOptions',
	type: 'collection',
	placeholder: 'Add Option',
	default: {},
	description: 'Must be the same in the nodes that insert into and retrieve from an index',
	options: [
		{
			displayName: 'Content Key',
			name: 'contentKey',
			type: 'string',
			default: 'content',
			description: 'Hash field that stores the document text',
		},
		{
			displayName: 'Distance Metric',
			name: 'distanceMetric',
			type: 'options',
			default: 'COSINE',
			options: [
				{ name: 'Cosine', value: 'COSINE' },
				{ name: 'Euclidean (L2)', value: 'L2' },
				{ name: 'Inner Product (IP)', value: 'IP' },
			],
		},
		{
			displayName: 'ID Metadata Field',
			name: 'idMetadataField',
			type: 'string',
			default: '',
			placeholder: 'e.g. doc_key',
			description:
				"Metadata field that holds each document's ID. Set it in the Document Loader's metadata: a non-empty string or number, unique per run. Inserting a document with an existing ID replaces it, and Update finds documents by this ID. Search results show the ID in this field. An ID that already starts with the Key Prefix is used as is. Leave empty for random IDs; search results then don't show them.",
		},
		{
			displayName: 'Key Prefix',
			name: 'keyPrefix',
			type: 'string',
			default: '',
			description:
				'Prefix of the keys the documents are stored under. Leave empty to use doc:&lt;index name&gt;:.',
		},
		{
			displayName: 'Metadata Key',
			name: 'metadataKey',
			type: 'string',
			default: 'metadata',
			description: 'Hash field that stores the document metadata as JSON',
		},
		{
			displayName: 'Vector Key',
			name: 'vectorKey',
			type: 'string',
			default: 'content_vector',
			description: 'Hash field that stores the embedding',
		},
	],
};

/** TTL option shared by Insert Options and the Update mode Options; each sets its own description. */
const ttlOption: INodeProperties = {
	displayName: 'TTL (Seconds)',
	name: 'ttl',
	type: 'number',
	typeOptions: { minValue: 0 },
	default: 0,
};

export const insertFields: INodeProperties[] = [
	indexOptionsField,
	{
		displayName: 'Metadata Fields to Index',
		name: 'metadataFields',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true, sortable: true },
		placeholder: 'Add Field',
		default: {},
		description:
			'Top-level metadata fields to index so retrieval can filter on them. Used when the index is created; inserts into an existing index write all of its indexed fields, and any field listed here must already be indexed.',
		options: [
			{
				displayName: 'Field',
				name: 'fields',
				values: [
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
						placeholder: 'e.g. source',
						description:
							'Top-level metadata key. Cannot contain spaces or punctuation such as . - : @ (underscores are fine), for example user_type.',
					},
					{
						displayName: 'Type',
						name: 'type',
						type: 'options',
						default: 'TAG',
						options: [
							{ name: 'Tag (Exact Match)', value: 'TAG' },
							{ name: 'Numeric (Range)', value: 'NUMERIC' },
						],
					},
				],
			},
		],
	},
	{
		displayName: 'Insert Options',
		name: 'insertOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Delete Index and Documents',
				name: 'clearIndex',
				type: 'boolean',
				default: false,
				description:
					"Whether to permanently delete the index and all of its documents before inserting. Documents are found by the key prefix the existing index was built with, or by the Key Prefix option if the index no longer exists. It deletes every key under the index's key prefixes, so use it only on indexes this node created, and not on an index or prefix shared with another workflow. If the insert fails after this, the deleted data is not restored.",
			},
			{
				...ttlOption,
				description: 'Expire each inserted document after this many seconds. 0 means never.',
			},
			{
				displayName: 'Vector Algorithm',
				name: 'algorithm',
				type: 'options',
				default: 'HNSW',
				description: 'Only used when the index is created',
				options: [
					{ name: 'HNSW', value: 'HNSW', description: 'Approximate search, fast on large indexes' },
					{ name: 'FLAT', value: 'FLAT', description: 'Exact search, slower on large indexes' },
				],
			},
		],
	},
];

const metadataFilterField: INodeProperties = {
	displayName: 'Metadata Filter',
	name: 'metadataFilter',
	type: 'fixedCollection',
	typeOptions: { multipleValues: true, sortable: true },
	placeholder: 'Add Condition',
	default: {},
	description:
		'Only return documents matching all conditions. Fields come from the index; declare them with "Metadata Fields to Index" when inserting.',
	options: [
		{
			displayName: 'Condition',
			name: 'conditions',
			values: [
				{
					displayName: 'Field Name or ID',
					name: 'field',
					type: 'options',
					typeOptions: {
						loadOptionsMethod: 'getFilterFields',
						loadOptionsDependsOn: ['valkeyIndex', 'indexOptions.metadataKey'],
					},
					default: '',
					description:
						'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				},
				{
					displayName: 'Field Type',
					name: 'fieldType',
					type: 'hidden',
					default: "={{$parameter['&field' ].split('|')[1]}}",
				},
				{
					displayName: 'Operator',
					name: 'tagOperator',
					type: 'options',
					default: 'is',
					displayOptions: { hide: { fieldType: ['NUMERIC'] } },
					options: [
						{
							name: 'Is',
							value: 'is',
						},
						{
							name: 'Is Any Of',
							value: 'isAnyOf',
						},
					],
				},
				{
					displayName: 'Operator',
					name: 'numericOperator',
					type: 'options',
					default: 'gte',
					displayOptions: { show: { fieldType: ['NUMERIC'] } },
					options: [
						{
							name: 'Between',
							value: 'between',
						},
						{
							name: 'Equals',
							value: 'equals',
						},
						{
							name: 'Greater Than or Equal',
							value: 'gte',
						},
						{
							name: 'Less Than or Equal',
							value: 'lte',
						},
					],
				},
				{
					displayName: 'Upper Bound',
					name: 'valueTo',
					type: 'string',
					default: '',
					displayOptions: { show: { fieldType: ['NUMERIC'], numericOperator: ['between'] } },
				},
				{
					displayName: 'Value',
					name: 'value',
					type: 'string',
					default: '',
					description:
						"For 'is any of', separate values with commas. For 'between', the lower bound.",
				},
			],
		},
	],
};

/** Get Many and Retrieve as Tool. */
export const loadFields: INodeProperties[] = [indexOptionsField, metadataFilterField];

/** Retrieve as Vector Store. */
export const retrieveFields: INodeProperties[] = [indexOptionsField, metadataFilterField];

/**
 * Update Document. An update writes the document whole under its ID,
 * replacing any existing one (or creating it): its content,
 * metadata and expiry are exactly what is set here.
 *
 * Update has no Document Loader input; n8n builds the document with its
 * N8nJsonLoader, which reads `jsonMode`, `jsonData` and `options.metadata`
 * from this node. The names must stay as they are for the loader to find them.
 */
export const updateFields: INodeProperties[] = [
	indexOptionsField,
	{
		// Fixed: without it the loader turns every string field of the item into
		// its own document, and n8n rejects the update.
		displayName: 'Content Source',
		name: 'jsonMode',
		type: 'hidden',
		default: 'expressionData',
	},
	{
		displayName: 'Content',
		name: 'jsonData',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '={{ $json.text }}',
		required: true,
		description:
			"Text of the updated document. It is embedded and replaces the document's content. Other fields of the input item are not stored unless you add them under Options > Metadata.",
	},
	{
		// Not "updateOptions": the n8n lint rule requires a collection whose name
		// contains "update" to be called "Update Fields", which reads as "fields
		// to change" and would mislead here.
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Metadata',
				name: 'metadata',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				placeholder: 'Add Field',
				default: {},
				description:
					"Metadata of the updated document. It replaces the document's previous metadata, so include every field to keep, such as fields used in metadata filters.",
				options: [
					{
						displayName: 'Field',
						name: 'metadataValues',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								required: true,
								placeholder: 'e.g. tenant',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				...ttlOption,
				description:
					'Expire the updated document after this many seconds. 0 means never. The previous expiry is not kept.',
			},
		],
	},
];
