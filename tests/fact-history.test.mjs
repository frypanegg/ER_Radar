import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {decideFactSource, mergeFactHistory} from '../lib/fact-reconciliation.mjs';
import {buildStageTimeline} from '../app/bargaining-history.ts';

const rejection = {date:'2026-11-07',stage:'S3',label:'합의안 부결',sourceUrl:'https://example.com/rejection',transitionEvidence:{statusBasis:'exception_transition',eventType:'tentative_rejected',sourceVerified:true}};
const agreement = {date:'2026-10-30',stage:'S5',label:'잠정합의',sourceUrl:'https://example.com/agreement'};
const seed = {stage:'S3',eventDate:'2026-11-08',factualStatus:'AUTO_COLLECTED_TITLE_BASIS',flowEvents:[agreement,rejection,{date:'2026-11-08',stage:'S3',label:'후속 기사'}]};

test('DB arrival preserves tentative agreement and rejection even after follow-up collection', () => {
  const fact = {stage:'S4',eventDate:'2026-08-19',flowEvents:[{date:'2026-08-19',stage:'S4',label:'교착'}]};
  assert.equal(decideFactSource({seed,fact}).use,'seed');
  const events = mergeFactHistory({seed,fact});
  assert.deepEqual(buildStageTimeline(events,{asOf:'2026-11-12'}).segments.map(s=>s.stage),['S4','S5','S3']);
  assert.ok(events.some(e=>e.sourceUrl===agreement.sourceUrl));
  assert.ok(events.some(e=>e.sourceUrl===rejection.sourceUrl));
  assert.equal(decideFactSource({seed:{...seed,flowEvents:[agreement,{...rejection,transitionEvidence:undefined}]},fact}).use,'db');
});

test('newer DB snapshot retains seed-only historical episodes', () => {
  const fact = {stage:'S3',eventDate:'2026-11-10',flowEvents:[{date:'2026-11-10',stage:'S3',label:'재교섭'}]};
  assert.equal(decideFactSource({seed,fact}).use,'db');
  assert.ok(mergeFactHistory({seed,fact}).some(e=>e.stage==='S5'));
});

test('same-source corrections replace mistakes without deleting separate episodes', () => {
  const fact = {stage:'S3',eventDate:'2026-11-10',flowEvents:[{...agreement,stage:'S3',label:'오분류 정정'}]};
  const merged = mergeFactHistory({seed,fact});
  assert.equal(merged.filter(e=>e.sourceUrl===agreement.sourceUrl).length,1);
  assert.equal(merged.find(e=>e.sourceUrl===agreement.sourceUrl).stage,'S3');
  assert.ok(merged.some(e=>e.sourceUrl===rejection.sourceUrl));
});

test('same-day rollback and repeated S5 episodes retain recorded order', () => {
  const events = [agreement,{...rejection,date:agreement.date}, {...agreement,date:'2026-11-10',sourceUrl:'https://example.com/second'}];
  const timeline = buildStageTimeline(mergeFactHistory({seed:{stage:'S5',eventDate:'2026-11-10',flowEvents:events},fact:null}),{asOf:'2026-11-12'});
  assert.deepEqual(timeline.segments.map(s=>s.stage),['S5','S3','S5']);
});

test('production POSCO history retains its actual S5 interval after the old DB row loads', async () => {
  const data=JSON.parse(await readFile(new URL('../data/current-2026-fact-seed.json',import.meta.url),'utf8'));
  const posco=data.records.find(r=>r.companyId==='posco');
  const fact={stage:'S4',eventDate:'2026-08-19',flowEvents:[{date:'2026-08-19',stage:'S4',label:'교착'}]};
  assert.equal(decideFactSource({seed:posco,fact}).use,'seed');
  const timeline=buildStageTimeline(mergeFactHistory({seed:posco,fact}),{asOf:'2026-11-12'});
  const tentative=timeline.segments.find(s=>s.stage==='S5'&&s.startDate==='2026-10-30');
  assert.equal(tentative.endDate,'2026-11-07');
  assert.ok(tentative.events.length>=4);
  assert.equal(timeline.segments.at(-1).stage,'S3');
});
