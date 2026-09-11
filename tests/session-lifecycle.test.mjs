import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const temp=mkdtempSync(join(tmpdir(),'crucible-session-tests-'));
after(()=>{if(resolve(temp).startsWith(resolve(tmpdir())+'\\')||resolve(temp).startsWith(resolve(tmpdir())+'/'))rmSync(temp,{recursive:true});});
writeFileSync(join(temp,'native.mjs'),`export const bridge={calls:[],handlers:{},invoke:async()=>{}};export const invoke=(name,args)=>{bridge.calls.push({name,args});return bridge.invoke(name,args)};export const isTauri=()=>true;export const listen=async(name,handler)=>{bridge.handlers[name]=handler;return ()=>delete bridge.handlers[name]};export const openUrl=async()=>{};
export class Terminal {options={};cols=80;rows=24;parser={registerOscHandler(){}};output=[];loadAddon(){}onData(fn){this.input=fn}attachCustomKeyEventHandler(){}reset(){this.output=[]}write(t){this.output.push(t)}writeln(t){this.output.push(t)}focus(){}dispose(){this.disposed=true}}
export class FitAddon{fit(){}}export class SearchAddon{}export class WebLinksAddon{}`);
const source=readFileSync(new URL('../src/sessions.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText.replace(/from "[^"]+"/g,'from "./native.mjs"');writeFileSync(join(temp,'sessions.mjs'),code);
const {bridge}=await import(pathToFileURL(join(temp,'native.mjs')));
const settings={fontSize:13,fontFamily:'',cursorStyle:'block',cursorBlink:true,scrollback:1000,recordUsage:true};
let sequence=0;
const setup=async()=>{bridge.calls=[];bridge.handlers={};bridge.invoke=async()=>{};return import(pathToFileURL(join(temp,'sessions.mjs'))+`?test=${sequence++}`)};
const launch=(id='run-one')=>({program:'fake',cwd:'C:\\Project',args:[],env:{},run:{id,agentId:'fake',agentName:'Fake',slotId:'pane',session:'Session',startedAt:1,outcome:'running'}});
test('Start refuses to replace a live process or its terminal',async()=>{
 const api=await setup();assert.equal(await api.startSession('pane',launch(),settings),true);const terminal=api.getSession('pane',settings).term;assert.equal(await api.startSession('pane',launch('another'),settings),false);assert.equal(api.getSession('pane',settings).term,terminal);assert.equal(bridge.calls.filter(c=>c.name==='spawn_agent').length,1);
});
test('Stop during launch waits and kills exactly once',async()=>{
 const api=await setup();let release;bridge.invoke=name=>name==='spawn_agent'?new Promise(r=>release=r):Promise.resolve();const starting=api.startSession('pane',launch(),settings);while(!release)await Promise.resolve();const a=api.stopSession('pane'),b=api.stopSession('pane');release();await Promise.all([starting,a,b]);assert.equal(api.sessionState('pane'),'stopped');assert.equal(bridge.calls.filter(c=>c.name==='kill_agent').length,1);
});
test('instant exit is not overwritten and old output cannot reach a restarted run',async()=>{
 const api=await setup();const events=[];api.subscribeSessions(e=>events.push(e));bridge.invoke=async name=>{if(name==='spawn_agent')bridge.handlers['agent-exit']({payload:{id:'pane',run_id:'run-one',code:0}})};await api.startSession('pane',launch(),settings);assert.equal(api.sessionState('pane'),'exited');assert.equal(events.filter(e=>e.completed).length,1);bridge.invoke=async()=>{};await api.startSession('pane',launch('run-two'),settings);const terminal=api.getSession('pane',settings).term;bridge.handlers['agent-output']({payload:{id:'pane',run_id:'run-one',data:btoa('stale')}});assert.equal(terminal.output.length,0);bridge.handlers['agent-exit']({payload:{id:'pane',run_id:'run-one',code:7}});assert.equal(api.sessionState('pane'),'running');
});
test('delivery failures reject and disabled recording reaches the native command',async()=>{
 const api=await setup();await api.startSession('pane',launch(),{...settings,recordUsage:false});assert.equal(bridge.calls.find(c=>c.name==='spawn_agent').args.recordOutput,false);bridge.invoke=async name=>{if(name==='write_to_agent')throw Error('pipe closed')};await assert.rejects(api.sendSession('pane','hello'),/pipe closed/);await assert.rejects(api.sendSession('offline','hello'),/not running/);
});
test('failed launches report one completion with a useful error',async()=>{
 const api=await setup();const events=[];api.subscribeSessions(e=>events.push(e));bridge.invoke=async()=>{throw Error('executable missing')};assert.equal(await api.startSession('pane',launch(),settings),false);assert.equal(api.sessionState('pane'),'failed');assert.equal(events.filter(e=>e.completed).length,1);assert.match(events.at(-1).error,/executable missing/);
});
