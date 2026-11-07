import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

/**
 * Connection details for a Valkey server, in either standalone or cluster
 * mode (selected by the Cluster Mode toggle).
 *
 * Valkey speaks its own protocol rather than HTTP, so this credential has no
 * declarative `test` block. The connection test lives on the node
 * (`methods.credentialTest.valkeyApiConnectionTest`, wired up with `testedBy`).
 */
export class ValkeyApi implements ICredentialType {
	name = 'valkeyApi';

	displayName = 'Valkey API';

	icon: Icon = { light: 'file:../icons/valkey.svg', dark: 'file:../icons/valkey.dark.svg' };

	documentationUrl = 'https://valkey.io/topics/acl/';

	properties: INodeProperties[] = [
		{
			displayName: 'Cluster Mode',
			name: 'cluster',
			type: 'boolean',
			default: false,
			description:
				'Whether the server runs in cluster mode. Enable to connect with a cluster client; Database Number is ignored, since a cluster has no logical databases.',
		},
		{
			displayName: 'Host',
			name: 'host',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'e.g. localhost',
			description:
				'Hostname or IP address of the Valkey server. For a cluster, use any node or the configuration endpoint.',
		},
		{
			displayName: 'Port',
			name: 'port',
			type: 'number',
			default: 6379,
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			description: 'ACL username. Leave empty to use the default user.',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'SSL/TLS',
			name: 'tls',
			type: 'boolean',
			default: true,
			description:
				'Whether to connect over TLS. Required when the server has in-transit encryption enabled.',
		},
		{
			displayName: 'Database Number',
			name: 'database',
			type: 'number',
			default: 0,
			description: 'Logical database to select. Ignored when Cluster Mode is enabled.',
			displayOptions: { hide: { cluster: [true] } },
		},
	];
}
