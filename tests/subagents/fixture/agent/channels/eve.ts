import { eveChannel } from 'eve/channels/eve';
import { httpBasic } from 'eve/channels/auth';
export default eveChannel({ auth: [httpBasic({ username: 'sbx12', password: process.env.SBX12_PASSWORD! })] });
