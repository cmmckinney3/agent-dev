import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Exercise the actual pure TypeScript models without adding a browser test runtime.
const temp = mkdtempSync(join(tmpdir(), 'crucible-model-tests-'));
for (const name of ['workspace', 'layout', 'agents', 'settings', 'tasks', 'usage', 'teammates']) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  writeFileSync(join(temp, `${name}.mjs`), outputText.replace(/from "\.\/([^"]+)"/g, 'from "./$1.mjs"'));
}
const { normalizeWorkspace, redactWorkspace, makeProject, retainRuns, queueCandidates, hasDependencyCycle, taskBlocker } = await import(pathToFileURL(join(temp, 'workspace.mjs')));
const { paneIds, splitPane, movePaneStep, removePane } = await import(pathToFileURL(join(temp, 'layout.mjs')));
const { draftFromTask } = await import(pathToFileURL(join(temp, 'tasks.mjs')));
after(() => { if (resolve(temp).startsWith(resolve(tmpdir()) + '\\') || resolve(temp).startsWith(resolve(tmpdir()) + '/')) rmSync(temp, { recursive: true }); });
const task = (id, patch = {}) => ({ id, title:id, prompt:'Do work', agentId:'codex', mode:'headless', status:'backlog', ...patch });

test('legacy migration preserves folder/config and marks interrupted tasks', () => {
  const w = normalizeWorkspace({cwd:'C:\\Work',tasks:[task('running',{status:'running',paneId:'old',queued:true})]});
  assert.equal(w.version,7); assert.equal(w.projects[0].cwd,'C:\\Work');
  assert.equal(w.tasks[0].status,'backlog'); assert.equal(w.tasks[0].interrupted,true);
  assert.equal(w.tasks[0].paneId,undefined); assert.equal(w.tasks[0].queued,false);
});
test('malformed backups are rejected before normalization changes live state', () => {
  for (const value of [null, [], {}, {tasks:{}}, {agents:[],tasks:[{title:'missing prompt'}]}, {agents:[],projects:[{layout:[]}]}, {agents:[],version:99}]) assert.throws(()=>normalizeWorkspace(value,true));
});
test('projects use globally distinct terminal IDs and preserve saved layouts', () => {
  const w=normalizeWorkspace({}); const a=makeProject('A','C:\\A',w.agents);const b=makeProject('B','C:\\B',w.agents);
  assert.equal(new Set([...paneIds(a.layout),...paneIds(b.layout)]).size,paneIds(a.layout).length+paneIds(b.layout).length);
  const restored=normalizeWorkspace({...w,projects:[{...a,savedLayout:a.layout},b]},true);
  assert.deepEqual(restored.projects[0].savedLayout,a.layout);
});
test('duplicate record IDs fail strict restore',()=>{
  assert.throws(()=>normalizeWorkspace({agents:[],tasks:[task('same'),task('same')]},true));
});
test('strict restore rejects circular or missing dependencies',()=>{
  for(const tasks of [[task('a',{dependencies:['a']})],[task('a',{dependencies:['missing']})],[task('a',{dependencies:['b']}),task('b',{dependencies:['a']})]]) assert.throws(()=>normalizeWorkspace({agents:[],tasks},true));
});
test('templates and drafts retain launch options',()=>{
  const w=normalizeWorkspace({});const draft={title:'Task',prompt:'Plan',agentId:w.agents[0].id,mode:'headless',priority:'high',cwd:'C:\\Work',isolation:true};
  w.templates=[{id:'template',name:'Plan',draft}];w.projects[0].draft=draft;
  const loaded=normalizeWorkspace(w,true);assert.equal(loaded.templates[0].draft.priority,'high');assert.equal(loaded.templates[0].draft.isolation,true);assert.equal(loaded.templates[0].draft.cwd,'C:\\Work');assert.equal(loaded.projects[0].draft.priority,'high');
});
test('saved layout retains settings for panes temporarily removed from the current layout',()=>{
  const w=normalizeWorkspace({});const p=w.projects[0];const id=paneIds(p.layout).at(-1);p.savedLayout=p.layout;p.slotNames[id]='Review';p.slotCwds[id]='C:\\Review';p.layout=removePane(p.layout,id);
  const loaded=normalizeWorkspace(w,true).projects[0];assert.equal(loaded.slotNames[id],'Review');assert.equal(loaded.slotCwds[id],'C:\\Review');assert.ok(paneIds(loaded.savedLayout).includes(id));
});
test('backup redaction omits API keys and every literal environment value',()=>{
  const w=normalizeWorkspace({});w.settings.openRouter.apiKey='sensitive';w.agents[0].env={UNUSUAL:'sensitive',API_TOKEN:'secret',MODEL:'{openrouter_model}'};
  const copy=redactWorkspace(w);assert.equal(copy.settings.openRouter.apiKey,'');assert.equal(copy.agents[0].env.UNUSUAL,'');assert.equal(copy.agents[0].env.API_TOKEN,'');assert.equal(copy.agents[0].env.MODEL,'{openrouter_model}');assert.equal(w.settings.openRouter.apiKey,'sensitive');
});
test('queue uses priority, stable user order, completed dependencies and archive state',()=>{
  const tasks=[task('first',{queued:true}),task('blocked',{queued:true,priority:'high',dependencies:['first']}),task('high',{queued:true,priority:'high'}),task('second',{queued:true}),task('archived',{queued:true,archived:true})];
  assert.deepEqual(queueCandidates(tasks).map(t=>t.id),['high','first','second']);
  tasks[0].status='done';assert.deepEqual(queueCandidates(tasks).map(t=>t.id),['blocked','high','second']);
});
test('dependency validation finds indirect and direct cycles',()=>{
  assert.equal(hasDependencyCycle([task('a',{dependencies:['b']}),task('b',{dependencies:['a']})]),true);
  assert.equal(hasDependencyCycle([task('a',{dependencies:['a']})]),true);
  assert.equal(hasDependencyCycle([task('a'),task('b',{dependencies:['a']})]),false);
  assert.match(taskBlocker(task('b',{dependencies:['a']}),[task('a')]),/Waiting for a/);
});
test('history retention never drops a live run',()=>{
  const runs=[{id:'live',outcome:'running'},...Array.from({length:6},(_,i)=>({id:String(i),outcome:'completed'}))];
  assert.deepEqual(retainRuns(runs,2).map(r=>r.id),['live','4','5']);
});
test('layout moves preserve terminal identity and other panes',()=>{
  const w=normalizeWorkspace({});const initial=w.projects[0].layout;const ids=paneIds(initial);
  const split=splitPane(initial,ids[0],'new-pane');const moved=movePaneStep(split,'new-pane','right',()=> 'new-column');
  assert.deepEqual(new Set(paneIds(moved)),new Set([...ids,'new-pane']));
  assert.deepEqual(new Set(paneIds(removePane(moved,'new-pane'))),new Set(ids));
  assert.deepEqual(paneIds(initial),ids);
});
test('drafts carry only composer fields, so saving cannot revive stale run state',()=>{
  const live=task('task-1',{status:'running',paneId:'pane-3',queued:true,interrupted:true,attention:'Needs input',lastExitCode:3,worktree:'C:\wt',reviewNotes:'looked fine',reviewedAt:5,projectId:'project-1',createdAt:1,archived:true,cwd:'C:\Work',priority:'high',dependencies:['task-2'],isolation:true});
  const draft=draftFromTask(live);
  assert.deepEqual(Object.keys(draft).sort(),['agentId','cwd','dependencies','isolation','mode','priority','prompt','teammateId','title']);
  // Re-saving an edited task must keep whatever the live record moved on to.
  const merged={...live,status:'review',paneId:undefined,queued:false,...draft};
  assert.equal(merged.id,'task-1'); assert.equal(merged.status,'review');
  assert.equal(merged.paneId,undefined); assert.equal(merged.queued,false);
  assert.equal(merged.cwd,'C:\Work'); assert.equal(merged.priority,'high');
  assert.deepEqual(merged.dependencies,['task-2']);
  // A template built from that draft cannot smuggle the source id into a new task.
  const fresh={id:'task-9',status:'backlog',...draftFromTask(draft)};
  assert.equal(fresh.id,'task-9'); assert.equal(fresh.status,'backlog');
  draft.dependencies.push('mutated'); assert.deepEqual(live.dependencies,['task-2']);
});
test('a task blocked by dependencies is queueable rather than unrunnable',()=>{
  const tasks=[task('dep'),task('blocked',{dependencies:['dep']})];
  assert.ok(taskBlocker(tasks[1],tasks));
  // Queueing is what the card offers; the drain must ignore it until the dep is done.
  tasks[1].queued=true;
  assert.deepEqual(queueCandidates(tasks).map(t=>t.id),[]);
  tasks[0].status='done';
  assert.equal(taskBlocker(tasks[1],tasks),undefined);
  assert.deepEqual(queueCandidates(tasks).map(t=>t.id),['blocked']);
});
test('dashboard state and desktop notifications normalize with safe defaults', async () => {
  const { normalizeSettings } = await import(pathToFileURL(join(temp, 'settings.mjs')));
  assert.equal(normalizeWorkspace({}).dashboardOpen, false);
  assert.equal(normalizeWorkspace({ dashboardOpen: true }).dashboardOpen, true);
  assert.equal(normalizeWorkspace({ dashboardOpen: 'yes' }).dashboardOpen, false);
  assert.equal(normalizeSettings({}).desktopNotifications, 'background');
  assert.equal(normalizeSettings({ desktopNotifications: 'always' }).desktopNotifications, 'always');
  assert.equal(normalizeSettings({ desktopNotifications: 'off' }).desktopNotifications, 'off');
  assert.equal(normalizeSettings({ desktopNotifications: 'loud' }).desktopNotifications, 'background');
});
