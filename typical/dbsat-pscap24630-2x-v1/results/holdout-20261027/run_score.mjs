// Applies the frozen scorer (../../score.mjs, unmodified) to evidence-r1.json / evidence-r2.json.
import fs from 'node:fs';
import { scoreRep, scoreCampaign } from '../../score.mjs';
const here = new URL('.', import.meta.url);
const reps = ['r1', 'r2'].map((r) => scoreRep(JSON.parse(fs.readFileSync(new URL(`evidence-${r}.json`, here)))));
console.log(JSON.stringify({ reps: { r1: reps[0], r2: reps[1] }, campaign: scoreCampaign([[reps[0]], [reps[1]]]) }, null, 2));
