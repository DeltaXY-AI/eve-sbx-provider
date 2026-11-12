import { defineAgent } from 'eve';
import { fixtureModel, modelSettings } from './lib/model';
export default defineAgent({ model: fixtureModel(), ...modelSettings, tool: false });
