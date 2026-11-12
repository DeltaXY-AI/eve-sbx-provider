import { makeSandbox } from '../lib/sandbox';
const definition = makeSandbox('parent');
export const environment = definition.environment;
export default definition.selector;
