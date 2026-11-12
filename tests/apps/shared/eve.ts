import { eveChannel } from 'eve/channels/eve';
import { httpBasic } from 'eve/channels/auth';
export default eveChannel({
  auth: [httpBasic({ username: 'sbx10', password: process.env.SBX10_PASSWORD! })],
});
