import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

/**
 * Connection details for a standalone Valkey server.
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
			displayName: 'Host',
			name: 'host',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'e.g. localhost',
			description: 'Hostname or IP address of the standalone Valkey server',
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
				'Whether to connect over TLS. Required for ElastiCache with in-transit encryption enabled.',
		},
		{
			displayName: 'Database Number',
			name: 'database',
			type: 'number',
			default: 0,
		},
	];
}
