import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, expect, it, onTestFinished } from "vitest";
import { gh, githubHostFromOrigin } from "./github.ts";
import {
  DEFAULT_DEADLINES,
  DEFAULT_IMPLEMENT_TOOLS,
  DEFAULT_RECOVERY,
  DEFAULT_REPAIR_ROUNDS,
  DEFAULT_WATCHDOG,
  loadLoopSettings,
} from "./settings.ts";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
// Fixture-based CLI tests can overlap; process.env-mutating tests stay sequential.
const cliTest = it.concurrent;
const cli = resolve(import.meta.dirname, "run.mjs");

function fixture(mode = "pass") {
  const root = mkdtempSync(join(tmpdir(), "issue-loop-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const path of [repo, bin, home]) mkdirSync(path);
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Loop Test",
    GIT_AUTHOR_EMAIL: "loop@example.test",
    GIT_COMMITTER_NAME: "Loop Test",
    GIT_COMMITTER_EMAIL: "loop@example.test",
    PATH: `${bin}:${process.env.PATH}`,
    FIXTURE_ROOT: root,
    FIXTURE_MODE: mode,
    FIXTURE_REVIEW_BODY: "",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main");
  writeFileSync(join(repo, "README.md"), "A test project\n");
  git("add", ".");
  git("commit", "-m", "Initial commit");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "main");
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = process.env.FIXTURE_ROOT;
const mode = process.env.FIXTURE_MODE;
fs.appendFileSync(path.join(root, 'gh-calls.jsonl'), JSON.stringify(args)+'\\n');
const issue = n => ({number:n, title:n === 10 ? 'Parent feature' : 'Ticket '+n, body:mode === 'unicode' ? 'Price €5.' : 'Implement the requested feature.', state:'open', html_url:'https://github.com/test/project/issues/'+n});
let result;
if (args[0] === 'repo' && args[1] === 'view') result = {nameWithOwner:process.env.GH_REPO && args[2] === '--json' ? process.env.GH_REPO : 'test/project', defaultBranchRef:{name:'main'}};
else if (args[0] === 'api') {
 const endpoint = args.find(a => a === 'user' || a.startsWith('repos/'));
 if (endpoint === 'user') result = {login:'loop-author'};
 else if (endpoint.endsWith('/sub_issues')) result = mode === 'empty' ? [[]] : mode.startsWith('parent-order') ? [[issue(12)], [issue(11)]] : [[issue(11)], [issue(12)]];
 else if (endpoint.endsWith('/dependencies/blocked_by')) result = [mode === 'parent-order' ? [] : endpoint.includes('/12/') ? [issue(11)] : mode === 'cycle' ? [issue(12)] : []];
 else if (endpoint.includes('/issues/99/comments') || endpoint.includes('/issues/comments/')) {
   const file = path.join(root, 'pr-comments.json');
   const comments = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
   const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
   if (method === 'GET') {
     if (!args.includes('--paginate') || !args.includes('--slurp')) { console.error('Missing pagination flags'); process.exit(2); }
     result = comments.map(comment => [comment]);
   }
   else {
     const bodyFile = args[args.indexOf('--field') + 1].slice('body=@'.length);
     const body = fs.readFileSync(bodyFile, 'utf8');
     if (method === 'POST') {
       result = {id: Math.max(0, ...comments.map(comment => comment.id)) + 1, body, user:{login:'loop-author'}};
       comments.push(result);
       fs.appendFileSync(path.join(root, 'comments-created.txt'), 'created\\n');
     } else if (method === 'PATCH') {
       result = comments.find(comment => comment.id === Number(endpoint.split('/').pop()));
       if (!result) { console.error('Comment not found'); process.exit(2); }
       result.body = body;
     } else { console.error('Unexpected comment method'); process.exit(2); }
     fs.writeFileSync(file, JSON.stringify(comments));
     if (mode === 'comment-create-fail' && method === 'POST') {
       console.error('Connection lost after posting comment'); process.exit(1);
     }
   }
 }
 else if (endpoint.endsWith('/comments')) result = mode === 'comments' ? [[{body:'UNTRUSTED_COMMENT_INSTRUCTION'}]] : [[]];
 else result = issue(Number(endpoint.split('/').pop()));
} else if (args[0] === 'pr' && args[1] === 'list') result = fs.existsSync(path.join(root, 'pr.json')) ? [{url:'https://github.com/test/project/pull/99', state:'OPEN'}] : [];
else if (args[0] === 'pr' && args[1] === 'create') {
 fs.writeFileSync(path.join(root, 'pr.json'), JSON.stringify(args));
 fs.appendFileSync(path.join(root, 'pr-created.txt'), 'created\\n');
 if (mode === 'publish-fail') { console.error('Connection lost after creating PR'); process.exit(1); }
 console.log('https://github.com/test/project/pull/99'); process.exit(0);
} else {console.error('Unexpected gh args', args); process.exit(2);}
const output = Buffer.from(JSON.stringify(result));
const split = mode === 'unicode' ? output.indexOf(Buffer.from('€')) : -1;
if (split >= 0) {
 process.stdout.write(output.subarray(0, split + 1));
 setTimeout(() => process.stdout.end(output.subarray(split + 1)), 50);
} else console.log(output.toString());
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "pi"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag)+1];
if (args.includes('--version')) { console.log(process.env.FIXTURE_PI_VERSION || '0.99.2'); process.exit(0); }
const name = value('--name') || '';
const session = value('--session');
const out = record => process.stdout.write(JSON.stringify(record)+'\\n');
const isParentReview = () => name.includes('parent review');
let promptCount = 0;
function materialSeverity(body) {
 const lower = String(body || '').toLowerCase();
 if (lower.includes('[critical]')) return 'critical';
 if (lower.includes('[major]')) return 'major';
 return 'minor';
}
function reviewOutcome() {
 const mode = process.env.FIXTURE_MODE;
 if (mode === 'malformed') return 'PASS, probably.';
 if (mode === 'legacy-review') return JSON.stringify({verdict:'pass', findings:[]});
 if (mode === 'review-incomplete') return JSON.stringify({outcome:'incomplete', summary:'Not finished reviewing.', findings:[], remainingWork:'Need more evidence.'});
 if (mode === 'reject' || (mode === 'parent-reject' && isParentReview()))
  return JSON.stringify({outcome:'changes_requested', summary:'Missing acceptance criterion', findings:[{axis:'spec',severity:'major',location:'feature.txt',description:'Missing acceptance criterion'}]});
 if (mode === 'blocked-review')
  return JSON.stringify({outcome:'blocked', summary:'Cannot assess required behavior', findings:[], blockers:'Missing required environment'});
 if (mode === 'pass-body') {
  const body = process.env.FIXTURE_REVIEW_BODY || '';
  const severity = materialSeverity(body);
  return JSON.stringify({outcome:'pass', summary:'Looks good.', findings: body ? [{axis:'spec',severity,location:'review',description:body}] : []});
 }
 if (mode === 'pass-notes' || mode === 'comment-create-fail') {
  const note = isParentReview() ? (process.env.FIXTURE_REVIEW_BODY || '[Standards][Minor] Parent cleanup') : '[Spec][Minor] Ticket cleanup';
  return JSON.stringify({outcome:'pass', summary:'Review passed.', findings:[{axis:'spec',severity:'minor',location:'review',description:note}]});
 }
 return JSON.stringify({outcome:'pass', summary:'Review passed.', findings:[]});
}
function implementOutcome() {
 const mode = process.env.FIXTURE_MODE;
 if (mode === 'editing-pass') return JSON.stringify({outcome:'pass', summary:'Done.'});
 if (mode === 'editing-incomplete') return JSON.stringify({outcome:'incomplete', summary:'Still working.', remainingWork:'Finish the parser.'});
 if (mode === 'editing-blocked') return JSON.stringify({outcome:'blocked', summary:'Stuck.', blockers:'Missing credentials.'});
 return JSON.stringify({outcome:'complete', summary:'Implemented the requested ticket.'});
}
function handle(command) {
 const prompt = command.message;
 fs.writeFileSync(session, JSON.stringify({type:'session_info', name})+'\\n');
 fs.appendFileSync(path.join(process.env.FIXTURE_ROOT, 'workers.jsonl'), JSON.stringify({name, session, args, prompt, cwd:process.cwd()})+'\\n');
 const isImplement = name.includes('implement');
 const isEditing = name.includes('implement') || name.includes('repair');
 const mode = process.env.FIXTURE_MODE;
 if (isParentReview()) fs.writeFileSync(path.join(process.env.FIXTURE_ROOT, 'parent-review-order.txt'), fs.existsSync(path.join(process.env.FIXTURE_ROOT,'pr.json')) ? 'after-pr' : 'before-pr');
 if (mode === 'fail-parent-review' && isParentReview() && command.type === 'prompt') { console.error('Provider unavailable'); process.exit(1); }
 if (command.type === 'steer') {
  out({id: command.id, type:'response', command:'steer', success:true, data:{disposition:'queued'}});
  return;
 }
 if (command.type === 'clear_queue') {
  out({id: command.id, type:'response', command:'clear_queue', success:true, data:{steering:[], followUp:[]}});
  return;
 }
 if (command.type === 'abort') {
  out({id: command.id, type:'response', command:'abort', success:true});
  process.exit(0);
 }
 if (command.type === 'prompt') promptCount++;
 if (isImplement && (mode === 'recover-transient' || mode === 'recover-exhausted' || mode === 'recover-correction')) {
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  if (mode === 'recover-correction' && promptCount === 1) {
   out({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'PASS, probably.'}]}});
   out({type:'agent_end', messages:[], willRetry:false});
   out({type:'agent_settled'});
   return;
  }
  if (mode === 'recover-exhausted' || (mode === 'recover-transient' && promptCount === 1)) {
   out({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'provider failed'}], stopReason:'error', errorMessage:'529 overloaded'}});
   out({type:'auto_retry_start', attempt:1, maxAttempts:3, delayMs:10, errorMessage:'529 overloaded'});
   out({type:'auto_retry_end', success:false, attempt:3, finalError:'529 overloaded'});
   out({type:'agent_end', messages:[], willRetry:false});
   out({type:'agent_settled'});
   return;
  }
  fs.writeFileSync('feature.txt', 'implemented\\n');
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text:implementOutcome()}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'repair-check') {
  if (isEditing) {
   if (name.includes('repair')) fs.writeFileSync('check-ok', 'ok');
   else fs.writeFileSync('feature.txt', 'implemented\\n');
  }
  const text = isEditing ? implementOutcome() : reviewOutcome();
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'retraction') {
  if (isEditing && !name.includes('repair')) fs.writeFileSync('feature.txt', 'implemented\\n');
  let text;
  if (isEditing) {
   text = name.includes('repair')
    ? JSON.stringify({outcome:'complete', summary:'The finding is mistaken: feature.txt already satisfies the requirement, so no change was made.'})
    : implementOutcome();
  } else if (name.includes('review')) {
   const counterFile = path.join(process.env.FIXTURE_ROOT, 'retraction-review-count');
   const count = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) + 1;
   fs.writeFileSync(counterFile, String(count));
   text = count === 1
    ? JSON.stringify({outcome:'changes_requested', summary:'Suspected missing behavior', findings:[{axis:'spec',severity:'major',location:'feature.txt',description:'Suspected missing behavior'}]})
    : JSON.stringify({outcome:'pass', summary:'Review passed.', findings:[]});
  } else {
   text = reviewOutcome();
  }
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'two-failures') {
  if (isEditing) {
   if (fs.existsSync('second.txt')) fs.writeFileSync('third.txt', 'third');
   else if (fs.existsSync('first.txt')) fs.writeFileSync('second.txt', 'second');
   else fs.writeFileSync('first.txt', 'first');
  }
  let text;
  if (isEditing) {
   text = implementOutcome();
  } else if (name.includes('review')) {
   const counterFile = path.join(process.env.FIXTURE_ROOT, 'two-failures-count');
   const count = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) + 1;
   fs.writeFileSync(counterFile, String(count));
   text = count === 1
    ? JSON.stringify({outcome:'changes_requested', summary:'First failure', findings:[{axis:'spec',severity:'major',location:'first.txt',description:'FIRST_FAILURE finding'}]})
    : count === 2
     ? JSON.stringify({outcome:'changes_requested', summary:'Second failure', findings:[{axis:'spec',severity:'major',location:'second.txt',description:'SECOND_FAILURE finding'}]})
     : JSON.stringify({outcome:'pass', summary:'Review passed.', findings:[]});
  } else {
   text = reviewOutcome();
  }
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'manual-repair') {
  if (isEditing) {
   if (name.includes('repair')) { console.error('Provider unavailable'); process.exit(1); }
   fs.writeFileSync('feature.txt', 'implemented\\n');
   const text = implementOutcome();
   out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
   out({type:'agent_start'});
   out({type:'message_start', message:{role:'assistant', content:[]}});
   out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
   out({type:'agent_end', messages:[], willRetry:false});
   out({type:'agent_settled'});
   return;
  }
  const text = JSON.stringify({outcome:'changes_requested', summary:'Repair the failing behavior', findings:[{axis:'spec',severity:'major',location:'feature.txt',description:'INTERRUPTED_REPAIR finding'}]});
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'manual-repair-check') {
  if (isEditing) {
   if (name.includes('repair')) { fs.writeFileSync('feature.txt', 'implemented\\n'); fs.writeFileSync('check-ok', 'ok'); }
   else fs.writeFileSync('feature.txt', 'implemented\\n');
   const text = implementOutcome();
   out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
   out({type:'agent_start'});
   out({type:'message_start', message:{role:'assistant', content:[]}});
   out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
   out({type:'agent_end', messages:[], willRetry:false});
   out({type:'agent_settled'});
   return;
  }
  const text = name.includes('audit') || fs.existsSync('check-ok')
   ? JSON.stringify({outcome:'pass', summary:'Review passed.', findings:[]})
   : JSON.stringify({outcome:'changes_requested', summary:'Checks still fail', findings:[{axis:'spec',severity:'major',location:'check-ok',description:'CHECKS_FAILING finding'}]});
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'manual-review') {
  if (isEditing) {
   fs.writeFileSync('feature.txt', 'implemented\\n');
   const text = implementOutcome();
   out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
   out({type:'agent_start'});
   out({type:'message_start', message:{role:'assistant', content:[]}});
   out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
   out({type:'agent_end', messages:[], willRetry:false});
   out({type:'agent_settled'});
   return;
  }
  console.error('Provider unavailable');
  process.exit(1);
 }
 if (mode === 'manual-audit-check') {
  if (isEditing) {
   if (name.includes('repair')) { console.error('Provider unavailable'); process.exit(1); }
   fs.writeFileSync('feature.txt', 'implemented\\n');
   const text = implementOutcome();
   out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
   out({type:'agent_start'});
   out({type:'message_start', message:{role:'assistant', content:[]}});
   out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
   out({type:'agent_end', messages:[], willRetry:false});
   out({type:'agent_settled'});
   return;
  }
  if (name.includes('audit')) {
   const auditFile = path.join(process.env.FIXTURE_ROOT, 'manual-audit-count');
   const auditCount = (fs.existsSync(auditFile) ? Number(fs.readFileSync(auditFile, 'utf8')) : 0) + 1;
   fs.writeFileSync(auditFile, String(auditCount));
   if (auditCount === 1) { console.error('Provider unavailable'); process.exit(1); }
   const auditText = JSON.stringify({outcome:'pass', summary:'Audit passed.', findings:[]});
   out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
   out({type:'agent_start'});
   out({type:'message_start', message:{role:'assistant', content:[]}});
   out({type:'message_end', message:{role:'assistant', content:[{type:'text', text: auditText}]}});
   out({type:'agent_end', messages:[], willRetry:false});
   out({type:'agent_settled'});
   return;
  }
  const counterFile = path.join(process.env.FIXTURE_ROOT, 'manual-audit-review-count');
  const count = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) + 1;
  fs.writeFileSync(counterFile, String(count));
  const text = count === 1
   ? JSON.stringify({outcome:'changes_requested', summary:'Fix the first attempt', findings:[{axis:'spec',severity:'major',location:'feature.txt',description:'FIRST_FAILURE finding'}]})
   : JSON.stringify({outcome:'pass', summary:'Review passed.', findings:[]});
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'repair-partial-fail' || mode === 'repair-partial-files-fail') {
  if (isEditing) {
   if (name.includes('repair')) {
    if (fs.existsSync('repair-partial.txt')) {
     fs.writeFileSync('fixed.txt', 'fixed\\n');
     const text = implementOutcome();
     out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
     out({type:'agent_start'});
     out({type:'message_start', message:{role:'assistant', content:[]}});
     out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
     out({type:'agent_end', messages:[], willRetry:false});
     out({type:'agent_settled'});
     return;
    }
    fs.writeFileSync('repair-partial.txt', 'partial\\n');
    if (mode === 'repair-partial-files-fail') fs.writeFileSync('repair-extra.txt', 'extra partial\\n');
    console.error('Provider unavailable');
    process.exit(1);
   }
   fs.writeFileSync('feature.txt', 'implemented\\n');
   const text = implementOutcome();
   out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
   out({type:'agent_start'});
   out({type:'message_start', message:{role:'assistant', content:[]}});
   out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
   out({type:'agent_end', messages:[], willRetry:false});
   out({type:'agent_settled'});
   return;
  }
  const text = fs.existsSync('fixed.txt')
   ? JSON.stringify({outcome:'pass', summary:'Review passed.', findings:[]})
   : JSON.stringify({outcome:'changes_requested', summary:'Repair required', findings:[{axis:'spec',severity:'major',location:'repair-partial.txt',description:'INCOMPLETE_REPAIR finding'}]});
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'stale-failure') {
  if (isEditing) {
   if (name.includes('repair')) fs.writeFileSync('fixed.txt', 'fixed');
   else fs.writeFileSync('feature.txt', 'implemented\\n');
   const text = implementOutcome();
   out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
   out({type:'agent_start'});
   out({type:'message_start', message:{role:'assistant', content:[]}});
   out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
   out({type:'agent_end', messages:[], willRetry:false});
   out({type:'agent_settled'});
   return;
  }
  if (name.includes('audit')) {
   const text = JSON.stringify({outcome:'blocked', summary:'Audit cannot run', findings:[], blockers:'Transient audit failure'});
   out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
   out({type:'agent_start'});
   out({type:'message_start', message:{role:'assistant', content:[]}});
   out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
   out({type:'agent_end', messages:[], willRetry:false});
   out({type:'agent_settled'});
   return;
  }
  const counterFile = path.join(process.env.FIXTURE_ROOT, 'stale-failure-review-count');
  const count = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) + 1;
  fs.writeFileSync(counterFile, String(count));
  const text = count === 1
   ? JSON.stringify({outcome:'changes_requested', summary:'First failure', findings:[{axis:'spec',severity:'major',location:'feature.txt',description:'STALE_FAILURE finding'}]})
   : JSON.stringify({outcome:'pass', summary:'Review passed.', findings:[]});
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'fixup') {
  if (isEditing) {
   if (fs.existsSync('first.txt')) fs.writeFileSync('second.txt', 'second');
   else fs.writeFileSync('first.txt', 'first');
  }
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  let text;
  if (isEditing) text = implementOutcome();
  else if (isParentReview()) text = JSON.stringify({outcome:'pass', summary:'Parent review passed.', findings:[]});
  else {
   const counterFile = path.join(process.env.FIXTURE_ROOT, 'fixup-review-count');
   const count = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) + 1;
   fs.writeFileSync(counterFile, String(count));
   text = count === 1
    ? JSON.stringify({outcome:'changes_requested', summary:'Fix the first attempt', findings:[{axis:'spec',severity:'major',location:'first.txt',description:'Fix the first attempt'}]})
    : JSON.stringify({outcome:'pass', summary:'Review passed.', findings:[]});
  }
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'hook-repair') {
  if (isEditing) {
   if (name.includes('repair')) fs.writeFileSync('hook-fixed.txt', 'fixed');
   else fs.writeFileSync('feature.txt', 'implemented\\n');
  }
  const text = isEditing ? implementOutcome() : reviewOutcome();
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'hook-mutation-repair') {
  if (isEditing) {
   if (name.includes('repair')) fs.writeFileSync('feature.txt', 'repaired\\n');
   else fs.writeFileSync('feature.txt', 'implemented\\n');
  }
  const text = isEditing ? implementOutcome() : reviewOutcome();
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'noop') {
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  const text = isEditing ? implementOutcome() : reviewOutcome();
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'review-edit' && !isEditing) {
  fs.appendFileSync(path.join(process.cwd(), 'feature.txt'), 'tampered');
  const text = JSON.stringify({outcome:'pass', summary:'Review passed.', findings:[]});
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
  out({type:'agent_end', messages:[], willRetry:false});
  out({type:'agent_settled'});
  return;
 }
 if (mode === 'stall-review' && !isEditing) {
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'tool_execution_start', toolCallId:'review-stall', toolName:'bash', args:{}});
  return;
 }
 if (mode === 'stall-implement' && isEditing) {
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'tool_execution_start', toolCallId:'implement-stall', toolName:'bash', args:{}});
  return;
 }
 if (mode === 'stall-after-write' && isEditing) {
  fs.writeFileSync('feature.txt', 'partial\\n');
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  out({type:'message_start', message:{role:'assistant', content:[]}});
  out({type:'tool_execution_start', toolCallId:'implement-stall', toolName:'bash', args:{}});
  return;
 }
 if (mode === 'stall-once' && !isEditing) {
  const counterFile = path.join(process.env.FIXTURE_ROOT, 'review-count');
  const count = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) + 1;
  fs.writeFileSync(counterFile, String(count));
  if (count === 1) {
   out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
   out({type:'agent_start'});
   out({type:'message_start', message:{role:'assistant', content:[]}});
   out({type:'tool_execution_start', toolCallId:'review-stall', toolName:'bash', args:{}});
   return;
  }
  if (count === 2) {
   const text = JSON.stringify({outcome:'changes_requested', summary:'Fix the review finding', findings:[{axis:'spec',severity:'major',location:'feature.txt',description:'Fix the review finding'}]});
   out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
   out({type:'agent_start'});
   out({type:'message_start', message:{role:'assistant', content:[]}});
   out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
   out({type:'agent_end', messages:[], willRetry:false});
   out({type:'agent_settled'});
   return;
  }
 }
 if (mode === 'fail-review-after-delay' && !isEditing) {
  out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
  out({type:'agent_start'});
  setTimeout(() => { console.error('Provider unavailable'); process.exit(1); }, 300);
  return;
 }
 if (isEditing) {
  if (mode === 'signal-exit') process.kill(process.pid, 'SIGTERM');
  if (mode === 'replace-lock') {
   const lock = path.join(path.dirname(path.dirname(session)), 'run.lock');
   fs.unlinkSync(lock);
   fs.writeFileSync(lock, 'new-owner\\n');
  }
  if (mode === 'missing-lock' || mode === 'directory-lock') {
   const lock = path.join(path.dirname(path.dirname(session)), 'run.lock');
   fs.unlinkSync(lock);
   if (mode === 'directory-lock') fs.mkdirSync(lock);
   console.error('Provider unavailable'); process.exit(1);
  }
  if (mode === 'unicode-error') {
   const output = Buffer.from('Provider says café');
   const split = output.indexOf(Buffer.from('é'));
   process.stderr.write(output.subarray(0, split + 1));
   setTimeout(() => { process.stderr.write(output.subarray(split + 1), () => process.exit(1)); }, 50);
   return;
  }
  if (mode === 'stubborn') {
   process.on('SIGTERM', () => {});
   fs.writeFileSync(path.join(process.env.FIXTURE_ROOT, 'stubborn.pid'), String(process.pid));
   setInterval(() => {}, 1000);
   return;
  }
  if (mode === 'commit-fail') {
   require('node:child_process').execFileSync('git', ['commit', '--allow-empty', '-m', 'Unauthorized worker commit']);
   process.exit(1);
  }
  if (mode === 'fail') { console.error('Provider unavailable'); process.exit(1); }
  if (mode === 'write-then-fail') {
   fs.writeFileSync('feature.txt', 'partial\\n');
   console.error('Provider unavailable');
   process.exit(1);
  }
  fs.writeFileSync('feature.txt', 'implemented\\n');
 }
 const text = isEditing ? implementOutcome() : reviewOutcome();
 out({id: command.id, type:'response', command:'prompt', success:true, data:{disposition:'started'}});
 out({type:'agent_start'});
 out({type:'message_start', message:{role:'assistant', content:[]}});
 out({type:'message_end', message:{role:'assistant', content:[{type:'text', text}]}});
 out({type:'agent_end', messages:[], willRetry:false});
 out({type:'agent_settled'});
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
 buffer += chunk;
 for (let i = buffer.indexOf('\\n'); i !== -1; i = buffer.indexOf('\\n')) {
  const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
  if (line.trim()) handle(JSON.parse(line));
 }
});
process.stdin.on('end', () => { process.exitCode = 0; });
`,
    { mode: 0o755 },
  );
  const run = async (...args: string[]) => {
    try {
      const result = await execFileAsync(process.execPath, [cli, ...args], {
        env: { ...env },
        encoding: "utf8",
        timeout: 30_000,
      });
      return { status: 0, ...result };
    } catch (error) {
      const failure = error as Error & { code?: number; stdout: string; stderr: string };
      if (typeof failure.code !== "number") throw error;
      return { status: failure.code, stdout: failure.stdout, stderr: failure.stderr };
    }
  };
  const start = () =>
    run(
      "start",
      "--repo",
      repo,
      "--issue",
      "10",
      "--check",
      `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`,
    );
  return { root, repo, env, git, run, start };
}

cliTest(
  "accepts dependent tickets on one branch and opens one final PR without closing issues",
  async () => {
    const f = fixture();
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)?.[1];
    expect(runDir).toBeTruthy();
    const state = JSON.parse(readFileSync(join(runDir!, "state.json"), "utf8"));
    expect(state.status).toBe("done");
    expect(state.tickets.map((ticket: { status: string }) => ticket.status)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(f.git("branch", "--show-current")).toBe("main");
    const summary = readFileSync(join(runDir!, "summary.md"), "utf8");
    expect(summary).toContain("https://github.com/test/project/pull/99");
    const workers = readFileSync(join(f.root, "workers.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(workers.every((worker) => worker.name.startsWith(state.name))).toBe(true);
    expect(new Set(workers.map((worker) => worker.session)).size).toBe(workers.length);
    const reviews = workers.filter((worker) => worker.name.includes("review"));
    expect(reviews.length).toBeGreaterThanOrEqual(3);
    expect(reviews.every((worker) => worker.args.includes("read,grep,find,ls"))).toBe(true);
    expect(workers.every((worker) => worker.args.includes("--no-skills"))).toBe(true);
    // RPC mode with ambient extensions disabled for every worker.
    expect(
      workers.every(
        (worker) =>
          worker.args.includes("--mode") &&
          worker.args[worker.args.indexOf("--mode") + 1] === "rpc" &&
          worker.args.includes("--no-extensions"),
      ),
    ).toBe(true);
    expect(reviews.every((worker) => worker.prompt.includes('"findings"'))).toBe(true);
    // Blessed defaults: implementers get the curated trio, reviewers get none.
    const implementers = workers.filter((worker) => worker.name.includes("implement"));
    expect(implementers.length).toBeGreaterThan(0);
    expect(implementers.every((worker) => worker.prompt.includes('"outcome"'))).toBe(true);
    expect(
      implementers.every(
        (worker) =>
          worker.args.includes("--skill") &&
          worker.args.some((arg: string) => arg.endsWith(join("skills", "tdd"))) &&
          worker.args.some((arg: string) => arg.endsWith(join("skills", "deslop"))),
      ),
    ).toBe(true);
    expect(reviews.every((worker) => !worker.args.includes("--skill"))).toBe(true);
    expect(existsSync(join(runDir!, "skills", "tdd", "SKILL.md"))).toBe(true);
    expect(existsSync(join(runDir!, "skills", "diagnosing-bugs", "SKILL.md"))).toBe(true);
    const prArgs = JSON.parse(readFileSync(join(f.root, "pr.json"), "utf8"));
    const baseIndex = prArgs.indexOf("--base");
    expect(prArgs.slice(baseIndex, baseIndex + 2)).toEqual(["--base", "main"]);
    // A passing final review with no findings is still posted as an advisory
    // comment with its verdict, summary, and reviewed artifact.
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Final whole-artifact review");
    expect(comments[0].body).toContain("(pass)");
    expect(comments[0].body).toContain("Review passed.");
    expect(comments[0].body).toContain(state.review.head);
    expect(comments[0].body).toContain(state.review.tree);
  },
  30_000,
);

cliTest(
  "keeps passing review bodies for tickets and parent without starting repairs",
  async () => {
    const f = fixture("pass-notes");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.status).toBe("done");
    expect(state.tickets.every((ticket: { repairs: number }) => ticket.repairs === 0)).toBe(true);
    expect(
      state.tickets.every(
        (ticket: { review: { outcome: string; findings: { description: string }[] } }) =>
          ticket.review.outcome === "pass" &&
          ticket.review.findings[0]?.description === "[Spec][Minor] Ticket cleanup",
      ),
    ).toBe(true);
    expect(state.review).toMatchObject({
      outcome: "pass",
      findings: [{ description: "[Standards][Minor] Parent cleanup" }],
    });
    const summary = readFileSync(join(runDir, "summary.md"), "utf8");
    expect(summary).toContain("Review observations");
    expect(summary).toContain("may have been resolved");
    expect(summary).toContain("[Spec][Minor] Ticket cleanup");
    expect(summary).toContain("[Standards][Minor] Parent cleanup");
    expect(summary).toContain(state.review.head);
    expect(summary).toContain(state.review.tree);
    expect(state.review.head).toBe(state.head);
    expect(state.review.tree).toBe(f.git("-C", state.worktree, "rev-parse", "HEAD^{tree}"));
    // The committed feature anchor is the exact reviewed artifact, then accepted.
    expect(state.tickets[0].review.head).toBe(state.tickets[0].anchor);
    expect(state.tickets[0].review.head).toBe(state.tickets[0].commit);
    expect(state.tickets[0].workHead).toBe(state.tickets[0].commit);
    for (const ticket of state.tickets) {
      expect(ticket.review.head).toMatch(/^[a-f0-9]{40}$/);
      expect(ticket.review.tree).toBe(f.git("rev-parse", `${ticket.commit}^{tree}`));
      // Controller-assigned finding identity and artifact reference.
      expect(ticket.review.findings[0]).toMatchObject({
        id: 1,
        artifact: { head: ticket.review.head, tree: ticket.review.tree },
      });
    }
    const pr = readFileSync(join(runDir, "pr.md"), "utf8");
    expect(pr).not.toContain("[Spec][Minor] Ticket cleanup");
    expect(pr).not.toContain("[Standards][Minor] Parent cleanup");
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("[Spec][Minor] Ticket cleanup");
    expect(comments[0].body).toContain("[Standards][Minor] Parent cleanup");
    expect(comments[0].body).toContain(state.review.tree);
  },
  30_000,
);

cliTest(
  "creates the PR before the advisory whole-artifact review without parent repairs",
  async () => {
    const f = fixture("parent-reject");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.status).toBe("done");
    // The final review is advisory: a material verdict is recorded, not repaired.
    expect(state.review).toMatchObject({ outcome: "changes_requested" });
    expect(state.advisoryWarning).toBeUndefined();
    // The PR existed before the review ran, and no parent editing was authorized.
    expect(readFileSync(join(f.root, "parent-review-order.txt"), "utf8").trim()).toBe("after-pr");
    const workers = readWorkers(f.root);
    expect(
      workers.some(
        (worker) =>
          worker.name.includes("parent implement") || worker.name.includes("parent repair"),
      ),
    ).toBe(false);
    // The advisory comment carries the finding, the reviewed SHA, and its outcome.
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    const advisory = comments.find((comment: { body: string }) =>
      comment.body.includes("Final whole-artifact review"),
    )!;
    expect(advisory.body).toContain("Missing acceptance criterion");
    expect(advisory.body).toContain(state.review.head);
    expect(advisory.body).toContain("changes_requested");
    expect(state.advisoryCommentId).toBeGreaterThan(0);
    // Child history is retained: no squash and no parent commit.
    const subjects = f.git("-C", state.worktree, "log", "--format=%s", `${state.baseSha}..HEAD`);
    expect(subjects).toContain("loop: #11 Ticket 11");
    expect(subjects).not.toContain("loop: parent");
  },
  30_000,
);

cliTest(
  "finishes with a visible warning when the advisory whole-artifact review is unavailable",
  async () => {
    const f = fixture("fail-parent-review");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.status).toBe("done");
    // A failed advisory review never claims a pass and never traps the PR.
    expect(state.review).toBeUndefined();
    expect(state.advisoryWarning).toContain("unavailable");
    expect(state.pr).toBe("https://github.com/test/project/pull/99");
    expect(existsSync(join(f.root, "pr.json"))).toBe(true);
    const summary = readFileSync(join(runDir, "summary.md"), "utf8");
    expect(summary).toContain("unavailable");
    expect(result.stderr).toContain("Warning");
  },
  30_000,
);

cliTest(
  "gates PR creation on required checks for the publication artifact",
  async () => {
    const f = fixture();
    const check = `${JSON.stringify(process.execPath)} -e "const fs=require('node:fs');const p=process.env.FIXTURE_ROOT+'/final-check-count';const n=(fs.existsSync(p)?+fs.readFileSync(p):0)+1;fs.writeFileSync(p,String(n));process.exit(n>=3?1:0)"`;
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.status).toBe("blocked");
    expect(state.phase).toBe("final");
    expect(state.lastError).toContain("Required checks failed for the publication artifact");
    expect(readFileSync(join(f.root, "final-check-count"), "utf8")).toBe("3");
    // No PR and no advisory review exist for an unverified artifact.
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
    expect(state.review).toBeUndefined();
    expect(state.tickets.every((ticket: { status: string }) => ticket.status === "accepted")).toBe(
      true,
    );
  },
  30_000,
);

cliTest(
  "persists a blocked review body before stopping",
  async () => {
    const f = fixture("blocked-review");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.tickets[0].review).toMatchObject({
      outcome: "blocked",
      summary: "Cannot assess required behavior",
    });
    expect(state.tickets[0].repairs).toBe(0);
  },
  30_000,
);

cliTest(
  "preserves a first-ticket failure, then reviews manual fixes on resume without repeating implementation",
  async () => {
    const f = fixture("fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(blocked.status).toBe("blocked");
    expect(blocked.tickets.map((ticket: { status: string }) => ticket.status)).toEqual([
      "blocked",
      "pending",
    ]);
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("Provider unavailable");
    expect(blocked.sessions[0].name).toContain("#11 implement · attempt 1");
    // An unsuccessful exit persists its elapsed runtime for resume.
    expect(typeof blocked.sessions[0].consumedMs).toBe("number");
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    expect(finished.name).toBe(blocked.name);
    expect(
      finished.sessions.filter((session: { name: string }) =>
        session.name.includes("#11 implement"),
      ),
    ).toHaveLength(1);
    expect(finished.sessions[1].name).toContain("#11 review · attempt 1");
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("pi --session");
  },
  30_000,
);

function writeLoopSettings(root: string): string {
  const dir = join(root, "loop-settings");
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "agents", "implement.md"),
    `---\ndescription: Test implementer\nmodel: test-provider/implement-model\nthinking: high\ntools: read, bash\n---\n\nCUSTOM IMPLEMENT GUIDANCE.`,
    "utf8",
  );
  writeFileSync(
    join(dir, "agents", "review.md"),
    `---\ndescription: Test reviewer\nmodel: test-provider/review-model\nthinking: low\ntools: read, grep\n---\n\nCUSTOM REVIEW GUIDANCE.`,
    "utf8",
  );
  const settingsPath = join(dir, "loop-settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      implementAgent: "./agents/implement.md",
      reviewAgent: "./agents/review.md",
      appendSystemPrompt: "SHARED STYLE NOTE.",
    }),
    "utf8",
  );
  return settingsPath;
}

function readWorkers(root: string): { name: string; args: string[]; prompt: string }[] {
  return readFileSync(join(root, "workers.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/**
 * Run a real `start` and kill the controller from a post-commit hook after Git
 * has created the commit but before the run records it, then let the detached
 * Git process release the worktree index lock. This is an interruption window,
 * not a state rewrite: the persisted intent and the real commit disagree only
 * because the controller died between Git and state persistence.
 */
async function startThenKillAfterCommit(f: ReturnType<typeof fixture>, prelude = "") {
  const hooks = join(f.repo, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    join(hooks, "post-commit"),
    `#!/bin/sh\n${prelude}if [ ! -f ../hook-killed ]; then\n  touch ../hook-killed\n  kill -9 "$(cat ../run.lock)" 2>/dev/null\nfi\n`,
    { mode: 0o755 },
  );
  const child = spawn(
    process.execPath,
    [cli, "start", "--repo", f.repo, "--issue", "10", "--check", "true"],
    { env: f.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (data) => (stdout += data.toString()));
  child.stderr.resume();
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  const runDir = stdout.match(/Run directory: (.+)/)![1];
  const worktree = join(runDir, "worktree");
  for (let i = 0; i < 100; i++) {
    try {
      f.git("-C", worktree, "status", "--porcelain");
      break;
    } catch {
      await delay(50);
    }
  }
  return { runDir, worktree, state: JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) };
}

cliTest(
  "applies settings roles to workers and snapshots them with the run",
  async () => {
    const f = fixture();
    const settingsPath = writeLoopSettings(f.root);
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`,
      "--settings",
      settingsPath,
    );
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)?.[1];
    const state = JSON.parse(readFileSync(join(runDir!, "state.json"), "utf8"));
    expect(state.settings).toEqual({
      implement: {
        agentName: "implement",
        model: "test-provider/implement-model",
        thinking: "high",
        tools: ["read", "bash"],
        skills: ["tdd", "diagnosing-bugs", "deslop"],
        promptBody: "CUSTOM IMPLEMENT GUIDANCE.",
      },
      repair: {
        agentName: "loop-repair",
        model: undefined,
        thinking: undefined,
        tools: DEFAULT_IMPLEMENT_TOOLS,
        skills: ["tdd", "diagnosing-bugs", "deslop"],
        promptBody: expect.stringContaining("Repair the findings"),
      },
      review: {
        agentName: "review",
        model: "test-provider/review-model",
        thinking: "low",
        tools: ["read", "grep"],
        skills: [],
        promptBody: "CUSTOM REVIEW GUIDANCE.",
      },
      repairRounds: DEFAULT_REPAIR_ROUNDS,
      watchdog: DEFAULT_WATCHDOG,
      recovery: DEFAULT_RECOVERY,
      deadlines: DEFAULT_DEADLINES,
      appendSystemPrompt: "SHARED STYLE NOTE.",
    });
    const workers = readWorkers(f.root);
    const implement = workers.find((worker) => worker.name.includes("implement"));
    for (const pair of [
      ["--model", "test-provider/implement-model"],
      ["--thinking", "high"],
      ["--tools", "read,bash"],
    ]) {
      const index = implement!.args.indexOf(pair[0]);
      expect(implement!.args.slice(index, index + 2)).toEqual(pair);
    }
    expect(implement!.args).toContain("--no-skills");
    expect(implement!.args).toContain("--skill");
    expect(implement!.args.some((arg: string) => arg.endsWith(join("skills", "tdd")))).toBe(true);
    expect(implement!.args).toContain("--append-system-prompt");
    expect(implement!.prompt).toContain("CUSTOM IMPLEMENT GUIDANCE.");
    expect(implement!.prompt).not.toContain("You are the implementation worker");
    const review = workers.find((worker) => worker.name.includes("review"));
    for (const pair of [
      ["--model", "test-provider/review-model"],
      ["--thinking", "low"],
      ["--tools", "read,grep"],
    ]) {
      const index = review!.args.indexOf(pair[0]);
      expect(review!.args.slice(index, index + 2)).toEqual(pair);
    }
    expect(review!.args).toContain("--no-skills");
    expect(review!.args).not.toContain("--skill");
    expect(review!.prompt).toContain("CUSTOM REVIEW GUIDANCE.");
    expect(review!.prompt).toContain('"findings"');
    expect(readFileSync(join(runDir!, "append-system-prompt.md"), "utf8")).toBe(
      "SHARED STYLE NOTE.\n",
    );
    expect(readFileSync(join(runDir!, "summary.md"), "utf8")).toContain("| #11");
  },
  30_000,
);

cliTest(
  "resumes from the settings snapshot after the original files are gone",
  async () => {
    const f = fixture("fail");
    const settingsPath = writeLoopSettings(f.root);
    const first = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`,
      "--settings",
      settingsPath,
    );
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const snapshot = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).settings;
    rmSync(join(f.root, "loop-settings"), { recursive: true, force: true });
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    expect(finished.settings).toEqual(snapshot);
    const workers = readWorkers(f.root);
    expect(workers.some((worker) => worker.args.includes("test-provider/review-model"))).toBe(true);
  },
  60_000,
);

cliTest(
  "fails fast on an unknown loop skill without creating workers",
  async () => {
    const f = fixture();
    const dir = join(f.root, "loop-settings");
    mkdirSync(dir, { recursive: true });
    const settingsPath = join(dir, "loop-settings.json");
    writeFileSync(settingsPath, JSON.stringify({ implementSkills: ["no-such-skill"] }), "utf8");
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown loop skill "no-such-skill"');
    expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
  },
  30_000,
);

cliTest(
  "stops on malformed review output rather than accepting a stray PASS string",
  async () => {
    const f = fixture("malformed");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.lastError).toContain("Invalid review outcome");
    expect(state.pr).toBeUndefined();
  },
  30_000,
);

cliTest.each([
  "[Spec][Major] Required behavior is missing",
  "[Standards][Critical] Data can be lost",
  "[Spec][Minor] Naming cleanup\n[Standards][Major] Broken workflow",
  "[spec][critical] Case-insensitive material finding",
])(
  "rejects a passing verdict with a material finding: %s",
  async (body) => {
    const f = fixture("pass-body");
    f.env.FIXTURE_REVIEW_BODY = body;
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.lastError).toContain("Invalid review outcome");
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.tickets[0].review).toBeUndefined();
    expect(state.tickets[0].commit).toBeUndefined();
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
  },
  30_000,
);

cliTest(
  "keeps reviewer closing directives out of the PR description",
  async () => {
    const f = fixture("pass-body");
    f.env.FIXTURE_REVIEW_BODY =
      "[Spec][Minor] Cleanup\n```\n# Forged heading\n````\nCloses #12345\nFixes other/repo#777";
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const pr = readFileSync(join(runDir, "pr.md"), "utf8");
    expect(pr).toContain("Closes #10");
    expect(pr).toContain("Closes #11");
    expect(pr).not.toContain("#12345");
    expect(pr).not.toContain("other/repo#777");
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(f.env.FIXTURE_REVIEW_BODY);
    expect(comments[0].body).toContain("`````");
  },
  30_000,
);

cliTest(
  "rejects the old findings contract",
  async () => {
    const f = fixture("legacy-review");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.lastError).toContain("Invalid review outcome");
    expect(state.tickets[0].review).toBeUndefined();
  },
  30_000,
);

cliTest(
  "preflights the installed Pi version before launching workers",
  async () => {
    const f = fixture();
    f.env.FIXTURE_PI_VERSION = "0.98.5";
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("older than the supported baseline 0.99.1");
    expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
  },
  30_000,
);

cliTest.each([
  ["editing-pass", "Invalid editing outcome"],
  // A voluntary incomplete consumes the one continuation and a second one is
  // bounded, retaining the phase allowance instead of finishing the attempt.
  ["editing-incomplete", "second-incomplete"],
  ["editing-blocked", "Implementation blocked"],
])(
  "does not approve invalid editing outcome %s",
  async (mode, error) => {
    const f = fixture(mode);
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.lastError).toContain(error);
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.tickets[0].commit).toBeUndefined();
    expect(state.phase).not.toBe("publish");
    expect(existsSync(join(f.root, "pr.json"))).toBe(false);
  },
  30_000,
);

cliTest(
  "bounds a repeated incomplete review outcome without accepting work",
  async () => {
    const f = fixture("review-incomplete");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.lastError).toContain("second-incomplete");
    expect(state.tickets[0].review).toBeUndefined();
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.tickets[0].commit).toBeUndefined();
    // The persisted stop reason retains the reported remaining work.
    const review = state.sessions.find((session: { name: string }) =>
      session.name.includes("review"),
    );
    expect(review.stopReason).toContain("second-incomplete");
    expect(review.stopReason).toContain("Need more evidence.");
  },
  30_000,
);

cliTest(
  "stops after the configured repair rounds and keeps the review findings for handoff",
  async () => {
    const f = fixture("reject");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(
      state.sessions.filter(
        (session: { name: string }) =>
          session.name.includes("implement") || session.name.includes("repair"),
      ),
    ).toHaveLength(4);
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.tickets[1].status).toBe("pending");
    expect(state.tickets[0].review).toMatchObject({
      outcome: "changes_requested",
      summary: "Missing acceptance criterion",
    });
    const summary = readFileSync(join(runDir, "summary.md"), "utf8");
    expect(summary).toContain("Missing acceptance criterion");
    expect(summary).toContain("| blocked | 3/3 |");
  },
  30_000,
);

cliTest(
  "finds an already-created PR after publication was interrupted",
  async () => {
    const f = fixture("publish-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.phase).toBe("publish");
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(join(f.root, "pr-created.txt"), "utf8")).toBe("created\n");
    expect((await f.run("resume", runDir)).status).toBe(0);
    expect(readFileSync(join(f.root, "pr-created.txt"), "utf8")).toBe("created\n");
  },
  30_000,
);

cliTest(
  "updates the same observations comment after an interrupted advisory post",
  async () => {
    const f = fixture("comment-create-fail");
    writeFileSync(
      join(f.root, "pr-comments.json"),
      JSON.stringify([{ id: 41, body: "Human notes", user: { login: "human" } }]),
    );
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.phase).toBe("advisory");
    expect(state.pr).toBe("https://github.com/test/project/pull/99");
    const originalPr = readFileSync(join(runDir, "pr.md"), "utf8");
    const existingComments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    const commentId = existingComments[1].id;
    existingComments[1].body = `Human introduction\n${existingComments[1].body}\nHuman follow-up`;
    const forged = { id: 43, body: existingComments[1].body, user: { login: "other-human" } };
    existingComments.push(forged);
    writeFileSync(join(f.root, "pr-comments.json"), JSON.stringify(existingComments));
    f.env.FIXTURE_MODE = "pass-notes";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const comments = JSON.parse(readFileSync(join(f.root, "pr-comments.json"), "utf8"));
    expect(comments).toHaveLength(3);
    expect(comments[0]).toEqual({ id: 41, body: "Human notes", user: { login: "human" } });
    expect(comments[2]).toEqual(forged);
    expect(comments[1].id).toBe(commentId);
    expect(comments[1].body).toContain("Human introduction");
    expect(comments[1].body).toContain("Human follow-up");
    expect(comments[1].body).toContain("[Standards][Minor] Parent cleanup");
    expect(comments[1].body).toContain(finished.review.tree);
    expect(readFileSync(join(f.root, "pr-created.txt"), "utf8")).toBe("created\n");
    expect(readFileSync(join(f.root, "comments-created.txt"), "utf8")).toBe("created\n");
    expect(JSON.parse(readFileSync(join(f.root, "pr.json"), "utf8"))).not.toContain("edit");
    expect(originalPr).not.toContain("Ticket cleanup");
    const calls: string[][] = readFileSync(join(f.root, "gh-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toContainEqual([
      "api",
      "repos/test/project/issues/99/comments",
      "--paginate",
      "--slurp",
    ]);
    expect(calls).toContainEqual([
      "api",
      "repos/test/project/issues/99/comments",
      "--method",
      "POST",
      "--field",
      `body=@${join(runDir, "review-observations.md")}`,
    ]);
    expect(calls).toContainEqual([
      "api",
      `repos/test/project/issues/comments/${commentId}`,
      "--method",
      "PATCH",
      "--field",
      `body=@${join(runDir, "review-observations.md")}`,
    ]);
    expect((await f.run("resume", runDir)).status).toBe(0);
    expect(readFileSync(join(f.root, "comments-created.txt"), "utf8")).toBe("created\n");
  },
  30_000,
);

cliTest(
  "reports a dependency cycle without starting a worker or publishing",
  async () => {
    const f = fixture("cycle");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.sessions).toEqual([]);
    expect(state.lastError).toContain("dependency cycle");
    expect(state.status).toBe("blocked");
  },
  30_000,
);

cliTest(
  "rejects an empty queue rather than claiming the parent is complete",
  async () => {
    const f = fixture("empty");
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No open direct child issues");
  },
  30_000,
);

cliTest(
  "stops a timed-out check instead of launching repair workers",
  async () => {
    const f = fixture("fail");
    const first = await f.start();
    expect(first.status, first.stderr).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)?.[1];
    expect(runDir, first.stderr).toBeTruthy();
    const statePath = join(runDir!, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.sessions).toHaveLength(1);
    writeFileSync(join(state.worktree, "feature.txt"), "Manually fixed\n");
    // Exercise real timeout handling on resume without the CLI's five-minute minimum.
    state.settings.deadlines.checkMs = 500;
    state.check = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('check-started', 'yes'); setInterval(() => {}, 1000)"`;
    writeFileSync(statePath, JSON.stringify(state));
    const result = await f.run("resume", runDir!);
    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(join(state.worktree, "check-started"), "utf8")).toBe("yes");
    const stopped = JSON.parse(readFileSync(statePath, "utf8"));
    expect(stopped.status).toBe("blocked");
    expect(stopped.sessions).toHaveLength(1);
    expect(stopped.lastError).toContain("Timed out running /bin/sh");
    expect(readWorkers(f.root)).toHaveLength(1);
  },
  30_000,
);

cliTest("rejects a timeout below the CLI minimum before starting workers", async () => {
  const f = fixture();
  const result = await f.run(
    "start",
    "--repo",
    f.repo,
    "--issue",
    "10",
    "--check",
    "true",
    "--timeout",
    "1",
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("--timeout must be 300 to 7200 seconds");
  expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
});

cliTest(
  "preserves manual edits after a publication failure until the operator commits them",
  async () => {
    const f = fixture("publish-fail");
    const first = await f.start();
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    writeFileSync(join(state.worktree, "feature.txt"), "Manual integration fix\n");
    // An uncommitted change is not a safe publication artifact: the gate blocks
    // with the work preserved instead of committing or reviewing it as parent work.
    const blocked = await f.run("resume", runDir);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("Uncommitted changes before publication");
    expect(readFileSync(join(state.worktree, "feature.txt"), "utf8")).toBe(
      "Manual integration fix\n",
    );
    // Once the operator commits it, resume publishes the same artifact.
    f.git("-C", state.worktree, "add", "-A");
    f.git("-C", state.worktree, "commit", "-m", "Manual integration fix");
    const manual = f.git("-C", state.worktree, "rev-parse", "HEAD");
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    expect(finished.head).toBe(manual);
    expect(
      finished.sessions.filter((session: { name: string }) =>
        session.name.includes("parent review"),
      ),
    ).toHaveLength(1);
    expect(readFileSync(join(state.worktree, "feature.txt"), "utf8")).toBe(
      "Manual integration fix\n",
    );
  },
  30_000,
);

cliTest(
  "does not replenish an exhausted repair budget on resume",
  async () => {
    const f = fixture("reject");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const before = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const implementations = (state: typeof before) =>
      state.sessions.filter(
        (session: { name: string }) =>
          session.name.includes("implement") || session.name.includes("repair"),
      ).length;
    expect((await f.run("resume", runDir)).status).toBe(1);
    const after = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(implementations(after)).toBe(implementations(before));
    // A human fix can still be verified after the automatic repair budget is gone.
    f.env.FIXTURE_MODE = "pass";
    writeFileSync(join(before.worktree, "feature.txt"), "Manual fix\n");
    expect((await f.run("resume", runDir)).status).toBe(0);
  },
  30_000,
);

cliTest(
  "binds GitHub operations to origin instead of an inherited GH_REPO",
  async () => {
    const f = fixture();
    Object.assign(f.env, { GH_REPO: "wrong/repository" });
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    expect(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).githubRepo).toBe(
      "test/project",
    );
  },
  30_000,
);

cliTest(
  "refuses to resume after origin is changed",
  async () => {
    const f = fixture("fail");
    const first = await f.start();
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    f.git("remote", "set-url", "origin", "https://github.com/wrong/repository.git");
    const result = await f.run("resume", runDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("origin");
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.sessions).toHaveLength(1);
  },
  30_000,
);

cliTest(
  "reports a forbidden HEAD change even when the worker exits unsuccessfully",
  async () => {
    const f = fixture("commit-fail");
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HEAD changed outside the controller");
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.tickets[0].status).toBe("blocked");
  },
  30_000,
);

cliTest(
  "handles repeated interrupts without leaving a detached worker running",
  async () => {
    const f = fixture("stubborn");
    const child = spawn(
      process.execPath,
      [cli, "start", "--repo", f.repo, "--issue", "10", "--check", "true"],
      { env: f.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.resume();
    const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
    let workerPid: number | undefined;
    try {
      const marker = join(f.root, "stubborn.pid");
      for (let i = 0; i < 200 && !existsSync(marker); i++) await delay(50);
      expect(existsSync(marker)).toBe(true);
      workerPid = Number(readFileSync(marker, "utf8"));
      child.kill("SIGINT");
      await delay(100);
      child.kill("SIGINT");
      await Promise.race([
        closed,
        delay(5000).then(() => {
          throw new Error("Controller did not stop");
        }),
      ]);
      const runDir = output.match(/Run directory: (.+)/)![1];
      const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
      expect(state.status).toBe("blocked");
      expect(existsSync(join(runDir, "run.lock"))).toBe(false);
      expect(() => process.kill(workerPid!, 0)).toThrow();
    } finally {
      child.kill("SIGKILL");
      if (workerPid) {
        try {
          process.kill(-workerPid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      await closed;
    }
  },
  30_000,
);

cliTest(
  "rejects origin with multiple push destinations",
  async () => {
    const f = fixture();
    const origin = f.git("remote", "get-url", "origin");
    f.git("config", "--add", "remote.origin.pushurl", origin);
    f.git("config", "--add", "remote.origin.pushurl", join(f.root, "unintended.git"));
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exactly one");
    expect(existsSync(join(f.root, "workers.jsonl"))).toBe(false);
  },
  30_000,
);

cliTest(
  "checks worktree-local remote settings before publication",
  async () => {
    const f = fixture("publish-fail");
    const first = await f.start();
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    f.git("config", "extensions.worktreeConfig", "true");
    f.git(
      "-C",
      state.worktree,
      "config",
      "--worktree",
      "remote.origin.pushurl",
      join(f.root, "unintended.git"),
    );
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toContain("origin must have exactly one");
  },
  30_000,
);

cliTest(
  "omits issue comments from saved requirements and every worker prompt",
  async () => {
    const f = fixture("comments");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.parent.body).toBe("Implement the requested feature.");
    expect(
      state.tickets.every(
        (ticket: { body: string }) => ticket.body === "Implement the requested feature.",
      ),
    ).toBe(true);
    const workers = readFileSync(join(f.root, "workers.jsonl"), "utf8");
    expect(workers).not.toContain("UNTRUSTED_COMMENT_INSTRUCTION");
    expect(workers).toContain("Implement the requested feature.");
  },
  30_000,
);

cliTest.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])(
  "refuses incompatible version-%s snapshots before launching workers",
  async (version) => {
    const f = fixture("fail");
    const first = await f.start();
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const statePath = join(runDir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.version = version;
    state.parent.body += "\n\n## Issue comments\n\nUNTRUSTED_COMMENT_INSTRUCTION";
    writeFileSync(statePath, JSON.stringify(state));
    const result = await f.run("resume", runDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("older snapshots may include issue comments");
    expect(readFileSync(join(f.root, "workers.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  },
  30_000,
);

cliTest.each([
  ["parent-order", [12, 11]],
  ["parent-order-dependency", [11, 12]],
] as const)(
  "preserves parent order while respecting dependencies (%s)",
  async (mode, expected) => {
    const f = fixture(mode);
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.tickets.map((ticket: { number: number }) => ticket.number)).toEqual([12, 11]);
    const workers = readFileSync(join(f.root, "workers.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      workers
        .filter((worker) => worker.name.includes("implement"))
        .map((worker) => Number(worker.name.match(/#(\d+) implement/)[1])),
    ).toEqual(expected);
  },
  30_000,
);

cliTest(
  "preserves UTF-8 issue text split across stdout chunks",
  async () => {
    const f = fixture("unicode");
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.parent.body).toBe("Price €5.");
    expect(state.tickets.every((ticket: { body: string }) => ticket.body === "Price €5.")).toBe(
      true,
    );
    expect(readFileSync(join(f.root, "workers.jsonl"), "utf8")).not.toContain("�");
  },
  30_000,
);

cliTest(
  "preserves UTF-8 error text split across stderr chunks",
  async () => {
    const f = fixture("unicode-error");
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Provider says café");
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("Provider says café");
  },
  30_000,
);

cliTest(
  "reports the signal when a worker is terminated externally",
  async () => {
    const f = fixture("signal-exit");
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pi terminated by SIGTERM");
    expect(result.stderr).not.toContain("exited null");
  },
  30_000,
);

cliTest.each(["missing-lock", "directory-lock"])(
  "preserves the primary error if lock cleanup fails (%s)",
  async (mode) => {
    const f = fixture(mode);
    const result = await f.start();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Provider unavailable");
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.status).toBe("blocked");
    expect(state.lastError).toContain("Provider unavailable");
    if (mode === "directory-lock")
      expect(result.stderr).toContain("Warning: could not remove run lock");
    else expect(result.stderr).not.toContain("ENOENT");
  },
  30_000,
);

cliTest(
  "creates a feature anchor and fixup history for changed child repairs",
  async () => {
    const f = fixture("fixup");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = state.tickets[0];
    expect(ticket.baseline).toBe(state.baseSha);
    expect(ticket.anchor).toMatch(/^[a-f0-9]{40}$/);
    expect(ticket.repairCommits).toHaveLength(1);
    expect(ticket.workHead).toBe(ticket.repairCommits[0]);
    // Acceptance is recorded separately from the work commits that built it.
    expect(ticket.commit).toBe(ticket.workHead);
    expect(ticket.anchor).not.toBe(ticket.commit);
    // The failed first assessment survives the feature/fixup cycle, still
    // linked to the anchor it reviewed, alongside the later passing verdict.
    expect(ticket.reviews).toHaveLength(1);
    expect(ticket.reviews[0]).toMatchObject({ outcome: "changes_requested" });
    expect(ticket.reviews[0].head).toBe(ticket.anchor);
    expect(ticket.reviews[0].tree).toBe(
      f.git("-C", state.worktree, "rev-parse", `${ticket.anchor}^{tree}`),
    );
    expect(ticket.reviews[0].findings[0]).toMatchObject({
      artifact: { head: ticket.anchor, tree: ticket.reviews[0].tree },
    });
    expect(ticket.review).toMatchObject({ outcome: "pass" });
    expect(
      f.git(
        "-C",
        state.worktree,
        "log",
        "--format=%s",
        "--reverse",
        `${state.baseSha}..${ticket.commit}`,
      ),
    ).toBe([`loop: #11 Ticket 11`, `fixup! loop: #11 Ticket 11`].join("\n"));
    // The second review saw the whole cumulative delta, not only the fixup.
    const patch = readFileSync(join(runDir, "review.patch"), "utf8");
    expect(patch).toContain("first.txt");
    expect(patch).toContain("second.txt");
  },
  30_000,
);

cliTest(
  "repairs findings in the reviewer conversation and audits them independently",
  async () => {
    const f = fixture("fixup");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const workers = readWorkers(f.root);
    const reviews = workers.filter((worker) => worker.name.includes("#11 review"));
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    const audits = workers.filter((worker) => worker.name.includes("#11 audit"));
    expect(reviews).toHaveLength(2);
    expect(repairs).toHaveLength(1);
    expect(audits).toHaveLength(1);
    // The first assessment is independent: no prior findings or repair notes.
    expect(reviews[0].prompt).not.toContain("Fix the first attempt");
    // The repair reopens the settled review conversation with additive editing
    // tools and repair skills, keeping the reviewer's model and thinking.
    expect(repairs[0].session).toBe(reviews[0].session);
    expect(reviews[1].session).not.toBe(reviews[0].session);
    expect(repairs[0].args[repairs[0].args.indexOf("--model") + 1]).toBe(
      state.settings.review.model,
    );
    expect(repairs[0].args[repairs[0].args.indexOf("--thinking") + 1]).toBe(
      state.settings.review.thinking,
    );
    const tools = repairs[0].args[repairs[0].args.indexOf("--tools") + 1].split(",");
    expect(tools).toEqual(
      expect.arrayContaining(["read", "grep", "find", "ls", "bash", "edit", "write"]),
    );
    expect(repairs[0].args).toContain("--no-skills");
    expect(repairs[0].args.some((arg) => arg.endsWith(join("skills", "tdd")))).toBe(true);
    expect(repairs[0].prompt).toContain("Fix the first attempt");
    // A fresh independent reviewer assesses the repaired artifact and again
    // sees no prior findings.
    expect(reviews[1].prompt).not.toContain("Fix the first attempt");
    // The audit shares the fresh reviewer's conversation and sees only the
    // latest failed findings plus the intervening repair explanation.
    expect(audits[0].session).toBe(reviews[1].session);
    expect(audits[0].prompt).toContain("Fix the first attempt");
    expect(audits[0].prompt).toContain("Intervening repair/retraction explanation");
    expect(state.tickets[0].audit).toMatchObject({ outcome: "pass" });
    expect(state.tickets[0].review).toMatchObject({ outcome: "pass" });
    // The review and its audit share one phase-task budget; the authorized
    // repair started a separate one in the same conversation.
    const review2 = [...state.sessions]
      .reverse()
      .find(
        (session: { kind: string; ticket?: number }) =>
          session.kind === "review" && session.ticket === 11,
      );
    const repairSession = state.sessions.find(
      (session: { kind: string; ticket?: number }) =>
        session.kind === "repair" && session.ticket === 11,
    );
    const auditSession = state.sessions.find(
      (session: { kind: string; ticket?: number }) =>
        session.kind === "audit" && session.ticket === 11,
    );
    expect(auditSession.phaseTask).toBe(review2.phaseTask);
    expect(repairSession.phaseTask).not.toBe(review2.phaseTask);
    expect(auditSession.consumedMs).toBeGreaterThanOrEqual(review2.consumedMs);
  },
  30_000,
);

cliTest(
  "returns failed checks to the last editing conversation and spends one repair round",
  async () => {
    const f = fixture("repair-check");
    const check = `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('check-ok')"`;
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const workers = readWorkers(f.root);
    const initial = workers.find((worker) => worker.name.includes("#11 implement"));
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    expect(repairs).toHaveLength(1);
    // The check-failure repair returned to the implement conversation rather
    // than starting a fresh editing session.
    expect(repairs[0].session).toBe(initial!.session);
    expect(repairs[0].prompt).toContain("Checks failed");
    expect(state.tickets[0].repairs).toBe(1);
    expect(state.tickets[0].status).toBe("accepted");
  },
  30_000,
);

cliTest(
  "records a no-change retraction, spends a repair round, and audits it",
  async () => {
    const f = fixture("retraction");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = state.tickets[0];
    expect(ticket.repairs).toBe(1);
    expect(ticket.retraction).toContain("finding is mistaken");
    // A no-change retraction manufactures no fixup commit.
    expect(ticket.repairCommits).toBeUndefined();
    const workers = readWorkers(f.root);
    expect(workers.filter((worker) => worker.name.includes("#11 repair"))).toHaveLength(1);
    const audits = workers.filter((worker) => worker.name.includes("#11 audit"));
    expect(audits).toHaveLength(1);
    expect(audits[0].prompt).toContain("finding is mistaken");
    expect(ticket.audit).toMatchObject({ outcome: "pass" });
  },
  30_000,
);

cliTest(
  "audits only the latest failed review's findings",
  async () => {
    const f = fixture("two-failures");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = state.tickets[0];
    expect(ticket.repairs).toBe(2);
    expect(ticket.reviews.map((review: { outcome: string }) => review.outcome)).toEqual([
      "changes_requested",
      "changes_requested",
    ]);
    expect(ticket.audit).toMatchObject({ outcome: "pass" });
    const workers = readWorkers(f.root);
    const rounds = workers.filter((worker) => worker.name.includes("#11 review"));
    expect(rounds).toHaveLength(3);
    // The third independent assessment sees neither earlier failure.
    expect(rounds[2].prompt).not.toContain("FIRST_FAILURE finding");
    expect(rounds[2].prompt).not.toContain("SECOND_FAILURE finding");
    // The audit receives only the latest failed findings.
    const audits = workers.filter((worker) => worker.name.includes("#11 audit"));
    expect(audits).toHaveLength(1);
    expect(audits[0].prompt).toContain("SECOND_FAILURE finding");
    expect(audits[0].prompt).not.toContain("FIRST_FAILURE finding");
  },
  30_000,
);

cliTest(
  "audits the latest failed review after an intervening passing assessment",
  async () => {
    const f = fixture("stale-failure");
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = blocked.tickets[0];
    // A failed review, a repair, and a passing assessment whose audit was
    // blocked. The archived pass must not hide the unresolved finding.
    expect(ticket.review.outcome).toBe("pass");
    expect(ticket.reviews.map((review: { outcome: string }) => review.outcome)).toEqual([
      "changes_requested",
    ]);
    expect(ticket.audit).toMatchObject({ outcome: "blocked" });
    // The operator edit archives the passing assessment after the failure.
    writeFileSync(join(blocked.worktree, "operator.txt"), "Operator edit\n");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].audit).toMatchObject({ outcome: "pass" });
    // The resumed audit must target the earlier failed finding, not the pass.
    const audits = readWorkers(f.root).filter((worker) => worker.name.includes("#11 audit"));
    expect(audits).toHaveLength(2);
    expect(audits[1].prompt).toContain("STALE_FAILURE finding");
  },
  30_000,
);

cliTest(
  "reviews manually fixed work on resume instead of resuming the stale repairer",
  async () => {
    const f = fixture("manual-repair");
    const check = `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`;
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(blocked.tickets[0].phase).toBe("repair");
    const repair = readWorkers(f.root).find((worker) => worker.name.includes("#11 repair"))!;
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].status).toBe("accepted");
    // The interrupted repairer is never reopened; a fresh reviewer assesses the
    // manual work and only then becomes the repairer if changes are requested.
    const workers = readWorkers(f.root);
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    const reviews = workers.filter((worker) => worker.name.includes("#11 review"));
    expect(repairs).toHaveLength(1);
    expect(reviews).toHaveLength(2);
    expect(workers.filter((worker) => worker.name.includes("#11 audit"))).toHaveLength(1);
    expect(reviews[1].session).not.toBe(repair.session);
    expect(reviews[1].prompt).not.toContain("INTERRUPTED_REPAIR finding");
    // Ticket #12 later overwrites feature.txt, so inspect the accepted #11 tree.
    expect(
      f.git("-C", finished.worktree, "show", `${finished.tickets[0].commit}:feature.txt`),
    ).toContain("Manually fixed");
  },
  30_000,
);

cliTest(
  "runs a fresh reviewer before repairing manually fixed work with failing checks",
  async () => {
    const f = fixture("manual-repair");
    const check = `${JSON.stringify(process.execPath)} -e "process.exit(require('node:fs').readFileSync('feature.txt','utf8').includes('implemented') ? 0 : 1)"`;
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    // The operator fixes the work but the required check still fails.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "manual-repair-check";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].status).toBe("accepted");
    const workers = readWorkers(f.root);
    const reviews = workers.filter((worker) => worker.name.includes("#11 review"));
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    // The resumed review sees the failure evidence and then repairs in its own
    // conversation; the stale crashed repairer is not reopened.
    expect(reviews[1].prompt).toContain("Check failure output");
    expect(repairs).toHaveLength(2);
    expect(reviews[1].session).toBe(repairs[1].session);
    expect(finished.tickets[0].repairs).toBe(2);
  },
  30_000,
);

cliTest(
  "starts a fresh reviewer after a blocked review when checks still fail on manual work",
  async () => {
    const f = fixture("blocked-review");
    const check = `${JSON.stringify(process.execPath)} -e "process.exit(require('node:fs').readFileSync('feature.txt','utf8').includes('implemented') ? 0 : 1)"`;
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(blocked.tickets[0].phase).toBe("review");
    expect(blocked.tickets[0].review.outcome).toBe("blocked");
    // The operator changes the work, but the required check still fails.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "manual-repair-check";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].status).toBe("accepted");
    const workers = readWorkers(f.root);
    const reviews = workers.filter((worker) => worker.name.includes("#11 review"));
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    // The blocked review is never resumed. Manual work gets a fresh reviewer
    // that sees the failing checks and then repairs in its own conversation.
    const fresh = reviews.find((worker) => worker.prompt.includes("Check failure output"));
    expect(fresh).toBeTruthy();
    expect(fresh!.session).not.toBe(blocked.tickets[0].reviewConversation);
    expect(repairs.at(-1)!.session).toBe(fresh!.session);
  },
  30_000,
);

cliTest(
  "starts a fresh reviewer after a crashed review when the operator changed the work",
  async () => {
    const f = fixture("manual-review");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(blocked.tickets[0].phase).toBe("review");
    expect(blocked.tickets[0].review).toBeUndefined();
    const interrupted = readWorkers(f.root).find((worker) => worker.name.includes("#11 review"))!;
    expect(interrupted).toBeTruthy();
    // The operator changes the work so the required check passes again.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].status).toBe("accepted");
    const reviews = readWorkers(f.root).filter((worker) => worker.name.includes("#11 review"));
    // The interrupted review conversation is not reused; a fresh reviewer
    // assesses the manually changed artifact.
    expect(reviews).toHaveLength(2);
    expect(reviews[1].session).not.toBe(interrupted.session);
  },
  30_000,
);

cliTest(
  "recovers a crashed manual review on a second resume instead of the stale editor",
  async () => {
    const f = fixture("manual-repair");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(blocked.tickets[0].phase).toBe("repair");
    const staleRepair = readWorkers(f.root).find((worker) => worker.name.includes("#11 repair"))!;
    // The operator fixes the work, then the fresh reviewer fails.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.env.FIXTURE_MODE = "manual-review";
    const crashed = await f.run("resume", runDir);
    expect(crashed.status).toBe(1);
    const interrupted = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    // The review handoff is persisted before the worker launches, so an
    // unchanged resume never reopens the stale repairer.
    expect(interrupted.tickets[0].phase).toBe("review");
    const freshReview = readWorkers(f.root)
      .filter((worker) => worker.name.includes("#11 review"))
      .at(-1)!;
    expect(freshReview.session).not.toBe(staleRepair.session);
    // A second unchanged resume recovers that review and its allowance.
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].repairs).toBe(1);
    const workers = readWorkers(f.root);
    expect(workers.filter((worker) => worker.name.includes("#11 repair"))).toHaveLength(1);
    expect(workers.filter((worker) => worker.name.includes("#11 review")).at(-1)!.session).toBe(
      freshReview.session,
    );
    // The operator's manual fix survives review and acceptance.
    expect(
      f.git("-C", finished.worktree, "show", `${finished.tickets[0].commit}:feature.txt`),
    ).toContain("Manually fixed");
  },
  30_000,
);

cliTest(
  "revalidates a cached pass and blocks when required checks fail after an interrupted audit",
  async () => {
    const f = fixture("manual-audit-check");
    const check = `${JSON.stringify(process.execPath)} -e "process.exit(require('node:fs').existsSync(process.env.FIXTURE_ROOT + '/check-fail') ? 1 : 0)"`;
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(first.status, first.stderr).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(blocked.tickets[0].phase).toBe("repair");
    // The operator fixes the work so the check still passes; the fresh reviewer
    // passes but its latest-findings audit is interrupted.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    const auditCrash = await f.run("resume", runDir);
    expect(auditCrash.status, auditCrash.stderr).toBe(1);
    const interrupted = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(interrupted.tickets[0].phase).toBe("audit");
    expect(interrupted.tickets[0].review).toMatchObject({ outcome: "pass" });
    expect(interrupted.tickets[0].audit).toBeUndefined();
    // Required checks now fail on an unchanged resume.
    writeFileSync(join(f.root, "check-fail"), "fail\n");
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(1);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("blocked");
    expect(finished.tickets[0].status).not.toBe("accepted");
    expect(finished.tickets[0].commit).toBeUndefined();
    // The cached pass is re-validated against the failing checks with the
    // failure evidence, consuming exactly one bounded correction before the
    // inconsistent pass blocks the child.
    const reviews = readWorkers(f.root).filter((worker) => worker.name.includes("#11 review"));
    expect(reviews.some((worker) => worker.prompt.includes("Check failure output"))).toBe(true);
    expect(reviews.some((worker) => worker.prompt.includes("could not accept"))).toBe(true);
    const failedReview = finished.sessions
      .filter(
        (session: { phaseTask?: string }) =>
          session.phaseTask === interrupted.tickets[0].reviewTask,
      )
      .at(-1);
    expect(failedReview.corrections).toBe(1);
    // The stale passing audit is never reused to accept the failed checks; the
    // cached pass is re-validated instead.
    expect(Number(readFileSync(join(f.root, "manual-audit-count"), "utf8"))).toBe(1);
  },
  30_000,
);

cliTest(
  "resumes a repair that saved files before failing without spending a repair round",
  async () => {
    const f = fixture("repair-partial-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(blocked.tickets[0].phase).toBe("repair");
    expect(blocked.tickets[0].repairs).toBe(1);
    const repair = readWorkers(f.root).find((worker) => worker.name.includes("#11 repair"))!;
    // Resume without any operator edit: the saved repair files are execution
    // recovery, so the same repair conversation resumes rather than a review
    // that would spend another code-repair round.
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    expect(finished.tickets[0].repairs).toBe(1);
    const repairs = readWorkers(f.root).filter((worker) => worker.name.includes("#11 repair"));
    expect(repairs).toHaveLength(2);
    expect(repairs[1].session).toBe(repair.session);
  },
  30_000,
);

cliTest(
  "recovers an interrupted repair after a manual descendant without renewing its budgets",
  async () => {
    const f = fixture("repair-partial-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const statePath = join(runDir, "state.json");
    const initial = JSON.parse(readFileSync(statePath, "utf8"));
    const anchor = initial.tickets[0].anchor;
    expect(anchor).toBeTruthy();
    rmSync(join(initial.worktree, "repair-partial.txt"));
    writeFileSync(join(initial.worktree, "operator.txt"), "Manual descendant\n");
    f.git("-C", initial.worktree, "add", "-A");
    f.git("-C", initial.worktree, "commit", "-m", "Manual descendant");
    const manual = f.git("-C", initial.worktree, "rev-parse", "HEAD");

    const second = await f.run("resume", runDir);
    expect(second.status).toBe(1);
    const stopped = JSON.parse(readFileSync(statePath, "utf8"));
    expect(stopped.tickets[0].phase).toBe("repair");
    expect(stopped.tickets[0].repairs).toBe(2);
    expect(stopped.tickets[0].anchor).toBe(anchor);
    const task = stopped.tickets[0].editTask;
    const conversation = stopped.tickets[0].editConversation;
    const latest = stopped.sessions.at(-1);
    expect(latest.phaseTask).toBe(task);
    // Model a durable checkpoint with already-consumed recovery allowances.
    latest.consumedMs = 1234;
    latest.continuationUsed = true;
    latest.transientRetries = 1;
    latest.corrections = 1;
    writeFileSync(statePath, JSON.stringify(stopped));
    const priorWorkers = readWorkers(f.root).length;

    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(statePath, "utf8"));
    const ticket = finished.tickets[0];
    expect(ticket.repairs).toBe(2);
    expect(ticket.baseline).toBe(initial.tickets[0].baseline);
    expect(ticket.anchor).toBe(anchor);
    expect(ticket.editTask).toBe(task);
    expect(ticket.editConversation).toBe(conversation);
    expect(readWorkers(f.root)[priorWorkers].name).toContain("#11 repair");
    const recovered = finished.sessions
      .filter((session: { phaseTask: string }) => session.phaseTask === task)
      .at(-1);
    expect(recovered.path).toBe(conversation);
    expect(recovered.consumedMs).toBeGreaterThanOrEqual(1234);
    expect(recovered.continuationUsed).toBe(true);
    expect(recovered.transientRetries).toBe(1);
    expect(recovered.corrections).toBe(1);
    expect(f.git("-C", finished.worktree, "merge-base", "--is-ancestor", manual, "HEAD")).toBe("");
  },
  30_000,
);

cliTest.each(["file edit", "same-tree commit"])(
  "starts fresh review when the operator makes a %s after an interrupted repair",
  async (change) => {
    const f = fixture("repair-partial-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const statePath = join(runDir, "state.json");
    const stopped = JSON.parse(readFileSync(statePath, "utf8"));
    const priorWorkers = readWorkers(f.root).length;
    if (change === "file edit") {
      writeFileSync(join(stopped.worktree, "operator.txt"), "Operator fix\n");
    } else {
      // A new HEAD is manual work even when every reviewable file is unchanged.
      f.git("-C", stopped.worktree, "commit", "--allow-empty", "-m", "Operator checkpoint");
    }
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readWorkers(f.root)[priorWorkers].name).toContain("#11 review");
    const finished = JSON.parse(readFileSync(statePath, "utf8"));
    expect(finished.tickets[0].repairs).toBe(2);
    expect(finished.tickets[0].editConversation).not.toBe(stopped.tickets[0].editConversation);
    expect(finished.tickets[0].anchor).toBe(stopped.tickets[0].anchor);
    expect(finished.tickets[0].baseline).toBe(stopped.tickets[0].baseline);
  },
  30_000,
);

cliTest.each([2, 1])(
  "routes manually reviewed partial work without bypassing the %i-round repair budget",
  async (repairRounds) => {
    const f = fixture("repair-partial-files-fail");
    const settings = join(f.root, "settings.json");
    writeFileSync(settings, JSON.stringify({ repairRounds }));
    const first = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settings,
    );
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const statePath = join(runDir, "state.json");
    const stopped = JSON.parse(readFileSync(statePath, "utf8"));
    const priorWorkers = readWorkers(f.root).length;
    // Preserve one verified file, leaving the interrupted worker's other file
    // unchanged and uncommitted. The whole content tree still matches the stop.
    f.git("-C", stopped.worktree, "add", "repair-partial.txt");
    f.git("-C", stopped.worktree, "commit", "-m", "Preserve verified partial repair");
    const manual = f.git("-C", stopped.worktree, "rev-parse", "HEAD");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    const subsequent = readWorkers(f.root).slice(priorWorkers);
    expect(subsequent[0].name).toContain("#11 review");
    expect(
      subsequent.some((worker) => worker.session === stopped.tickets[0].editConversation),
    ).toBe(false);
    if (repairRounds === 1) {
      expect(resumed.status).toBe(1);
      const blocked = JSON.parse(readFileSync(statePath, "utf8"));
      expect(blocked.lastError).toContain("exhausted its repair budget");
      expect(blocked.tickets[0].repairs).toBe(1);
      expect(blocked.tickets[0].status).not.toBe("accepted");
      expect(subsequent).toHaveLength(1);
      return;
    }
    expect(resumed.status, resumed.stderr).toBe(0);
    const completion = subsequent.find((worker) => worker.name.includes("#11 repair"))!;
    expect(completion.session).toBe(subsequent[0].session);
    expect(completion.prompt).toContain("not committable yet");
    const finished = JSON.parse(readFileSync(statePath, "utf8"));
    const ticket = finished.tickets[0];
    expect(ticket.repairs).toBe(2);
    expect(ticket.editTask).not.toBe(stopped.tickets[0].editTask);
    expect(ticket.editConversationRole).toBe("review");
    expect(ticket.anchor).toBe(stopped.tickets[0].anchor);
    expect(ticket.baseline).toBe(stopped.tickets[0].baseline);
    expect(
      f.git("-C", finished.worktree, "merge-base", "--is-ancestor", manual, ticket.commit),
    ).toBe("");
    expect(f.git("-C", finished.worktree, "show", `${ticket.commit}:repair-extra.txt`)).toBe(
      "extra partial",
    );
    const reviews = subsequent.filter((worker) => worker.name.includes("#11 review"));
    expect(reviews).toHaveLength(2);
    expect(reviews[1].session).not.toBe(completion.session);
  },
  30_000,
);

cliTest(
  "adopts a verified manual commit as the child anchor and targets fixups at it",
  async () => {
    const f = fixture("write-then-fail");
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(first.status, first.stderr).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(blocked.tickets[0].anchor).toBeUndefined();
    // The operator commits their manual implementation without rewriting anything.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually implemented\n");
    f.git("-C", blocked.worktree, "add", "-A");
    f.git("-C", blocked.worktree, "commit", "-m", "Manual implementation");
    const manual = f.git("-C", blocked.worktree, "rev-parse", "HEAD");
    f.env.FIXTURE_MODE = "fixup";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = finished.tickets[0];
    // The manual commit becomes the child anchor with its origin recorded...
    expect(ticket.anchor).toBe(manual);
    expect(ticket.anchorOrigin).toBe("manual");
    expect(ticket.repairCommits).toHaveLength(1);
    expect(ticket.commit).toBe(ticket.repairCommits[0]);
    // ...its subject and history stay unchanged, and later work fixes it up.
    expect(f.git("-C", finished.worktree, "log", "--format=%s", "-1", manual)).toBe(
      "Manual implementation",
    );
    expect(
      f.git("-C", finished.worktree, "log", "--format=%s", "-1", ticket.repairCommits[0]),
    ).toBe("fixup! Manual implementation");
    expect(f.git("-C", finished.worktree, "rev-parse", `${ticket.repairCommits[0]}^`)).toBe(manual);
  },
  30_000,
);

cliTest(
  "reviews a descendant manual commit with failing checks before repairing it",
  async () => {
    const f = fixture("write-then-fail");
    const check = `${JSON.stringify(process.execPath)} -e "process.exit(require('node:fs').readFileSync('feature.txt','utf8').includes('implemented') ? 0 : 1)"`;
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(first.status, first.stderr).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    writeFileSync(join(blocked.worktree, "feature.txt"), "Manually fixed\n");
    f.git("-C", blocked.worktree, "add", "-A");
    f.git("-C", blocked.worktree, "commit", "-m", "Manual fix");
    const manual = f.git("-C", blocked.worktree, "rev-parse", "HEAD");
    f.env.FIXTURE_MODE = "manual-repair-check";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = finished.tickets[0];
    expect(finished.status).toBe("done");
    expect(ticket.anchor).toBe(manual);
    expect(ticket.anchorOrigin).toBe("manual");
    expect(ticket.repairCommits).toHaveLength(1);
    const workers = readWorkers(f.root);
    const reviews = workers.filter((worker) => worker.name.includes("#11 review"));
    const repairs = workers.filter((worker) => worker.name.includes("#11 repair"));
    // The fresh reviewer sees the failure evidence and the whole artifact, then
    // repairs in its own conversation instead of the stale editor.
    expect(reviews[0].prompt).toContain("Check failure output");
    expect(repairs).toHaveLength(1);
    expect(repairs[0].session).toBe(reviews[0].session);
  },
  30_000,
);

cliTest(
  "stops on ambiguous manual commits instead of guessing an anchor",
  async () => {
    const f = fixture("write-then-fail");
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(first.status, first.stderr).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    writeFileSync(join(blocked.worktree, "one.txt"), "one\n");
    f.git("-C", blocked.worktree, "add", "-A");
    f.git("-C", blocked.worktree, "commit", "-m", "First manual commit");
    writeFileSync(join(blocked.worktree, "two.txt"), "two\n");
    f.git("-C", blocked.worktree, "add", "-A");
    f.git("-C", blocked.worktree, "commit", "-m", "Second manual commit");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(after.status).toBe("blocked");
    expect(after.lastError).toContain("ambiguous");
    // No guessed anchor, no controller commit, and no worker launched: the
    // operator has to resolve the attribution by hand.
    expect(after.tickets[0].anchor).toBeUndefined();
    expect(after.tickets[0].commit).toBeUndefined();
    expect(readWorkers(f.root)).toHaveLength(1);
  },
  30_000,
);

cliTest(
  "refuses a rewritten accepted ancestry on resume",
  async () => {
    const f = fixture("publish-fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(
      blocked.tickets.every((ticket: { status: string }) => ticket.status === "accepted"),
    ).toBe(true);
    const accepted = blocked.head;
    // Rewriting accepted history creates a new commit that no longer descends
    // from the recorded accepted SHA.
    f.git("-C", blocked.worktree, "commit", "--amend", "-m", "Rewritten accepted work");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(after.status).toBe("blocked");
    expect(after.lastError).toContain("rewritten");
    // The rewritten work is preserved rather than discarded.
    expect(f.git("-C", after.worktree, "log", "--format=%s", "-1")).toBe("Rewritten accepted work");
    expect(accepted).not.toBe(f.git("-C", after.worktree, "rev-parse", "HEAD"));
  },
  30_000,
);

cliTest(
  "refuses a switched worktree branch on resume",
  async () => {
    const f = fixture("fail");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    f.git("-C", blocked.worktree, "checkout", "-b", "operator-branch");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(after.status).toBe("blocked");
    expect(after.lastError).toContain("feature branch");
  },
  30_000,
);

cliTest(
  "reviews and commits staged manual changes through normal hooks",
  async () => {
    const f = fixture("write-then-fail");
    const first = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(first.status, first.stderr).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    // The operator stages a manual fix instead of leaving it unstaged.
    writeFileSync(join(blocked.worktree, "feature.txt"), "Staged manual fix\n");
    f.git("-C", blocked.worktree, "add", "feature.txt");
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = finished.tickets[0];
    expect(finished.status).toBe("done");
    expect(ticket.status).toBe("accepted");
    expect(ticket.anchor).toMatch(/^[a-f0-9]{40}$/);
    expect(f.git("-C", finished.worktree, "show", `${ticket.anchor}:feature.txt`)).toContain(
      "Staged manual fix",
    );
  },
  30_000,
);

cliTest(
  "uses dedicated repair guidance and skills while keeping the reviewer model",
  async () => {
    const f = fixture("fixup");
    const dir = join(f.root, "repair-settings");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "repair.md"),
      `---
description: Test repairer
tools: read, bash, edit
---

CUSTOM REPAIR GUIDANCE.`,
      "utf8",
    );
    const settingsPath = join(dir, "loop-settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ repairAgent: "./repair.md", repairSkills: ["diagnosing-bugs"] }),
      "utf8",
    );
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.settings.repair).toMatchObject({
      promptBody: "CUSTOM REPAIR GUIDANCE.",
      tools: ["read", "bash", "edit"],
      skills: ["diagnosing-bugs"],
    });
    const repair = readWorkers(f.root).find((worker) => worker.name.includes("#11 repair"))!;
    expect(repair.prompt).toContain("CUSTOM REPAIR GUIDANCE.");
    expect(repair.args).toContain("--no-skills");
    expect(repair.args.some((arg) => arg.endsWith(join("skills", "diagnosing-bugs")))).toBe(true);
    // The custom repair tools are additive to the review conversation's tools.
    const tools = repair.args[repair.args.indexOf("--tools") + 1].split(",");
    expect(tools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "bash", "edit"]));
    // The reviewer's model and thinking are not silently switched.
    expect(repair.args[repair.args.indexOf("--model") + 1]).toBe(state.settings.review.model);
  },
  30_000,
);

cliTest(
  "creates no commit for a completed phase that changed nothing",
  async () => {
    const f = fixture("noop");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.head).toBe(state.baseSha);
    expect(f.git("-C", state.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe("0");
    for (const ticket of state.tickets) {
      expect(ticket.anchor).toBeUndefined();
      expect(ticket.commit).toBe(state.baseSha);
    }
  },
  30_000,
);

cliTest(
  "records a work commit without accepting the ticket when review is blocked",
  async () => {
    const f = fixture("blocked-review");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = state.tickets[0];
    expect(ticket.anchor).toMatch(/^[a-f0-9]{40}$/);
    expect(ticket.workHead).toBe(ticket.anchor);
    // A recorded work commit is not ticket acceptance.
    expect(ticket.commit).toBeUndefined();
    expect(ticket.status).toBe("blocked");
    expect(ticket.review).toMatchObject({ outcome: "blocked" });
    expect(f.git("-C", state.worktree, "log", "--format=%s", "-1", ticket.anchor)).toBe(
      "loop: #11 Ticket 11",
    );
  },
  30_000,
);

cliTest(
  "rechecks a clean hook mutation before review",
  async () => {
    const f = fixture("blocked-review");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\necho mutated >> feature.txt\ngit add feature.txt\n`,
      { mode: 0o755 },
    );
    const check = `${JSON.stringify(process.execPath)} -e "const fs=require('node:fs');fs.appendFileSync(process.env.FIXTURE_ROOT + '/checks.txt', 'x');process.stdout.write(fs.readFileSync('feature.txt','utf8'))"`;
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = state.tickets[0];
    expect(ticket.anchor).toMatch(/^[a-f0-9]{40}$/);
    // The hook-mutated committed tree is reviewed, so checks ran again first.
    expect(readFileSync(join(f.root, "checks.txt"), "utf8")).toHaveLength(2);
    expect(f.git("-C", state.worktree, "show", `${ticket.anchor}:feature.txt`)).toContain(
      "mutated",
    );
    // The reviewer gets the recheck log describing the tree it actually reads.
    const review = readWorkers(f.root).find((entry) => entry.name.includes("review"))!;
    const checkLog = review.prompt.match(/Successful check output: (.+)/)![1];
    expect(readFileSync(checkLog, "utf8")).toContain("mutated");
  },
  30_000,
);

cliTest(
  "stops without reconciling when a successful hook leaves the worktree dirty",
  async () => {
    const f = fixture("blocked-review");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\necho dirty >> feature.txt\n`, {
      mode: 0o755,
    });
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.lastError).toContain("dirty after committing");
    expect(state.tickets[0].anchor).toMatch(/^[a-f0-9]{40}$/);
    // The recorded commit and the dirty-hook disposition are persisted together,
    // so a crash cannot leave leftovers unattributed for a later resume.
    expect(state.tickets[0].hookStop).toBeDefined();
    expect(state.pendingCommit).toBeUndefined();
    // The hook's work is preserved rather than discarded or auto-committed.
    expect(readFileSync(join(state.worktree, "feature.txt"), "utf8")).toContain("dirty");
  },
  30_000,
);

cliTest(
  "does not auto-commit or accept an unchanged resume after a dirty hook",
  async () => {
    const f = fixture();
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    // Dirty the worktree on the first successful commit only; a later resume
    // must not silently turn the leftover into a fixup.
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nif [ ! -f "${join(f.root, "hook-dirtied-once")}" ]; then\n  touch "${join(f.root, "hook-dirtied-once")}"\n  echo dirty >> feature.txt\nfi\n`,
      { mode: 0o755 },
    );
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const anchor = blocked.tickets[0].anchor;
    expect(anchor).toMatch(/^[a-f0-9]{40}$/);
    expect(blocked.lastError).toContain("dirty after committing");
    expect(blocked.tickets[0].commit).toBeUndefined();
    // Resume with no explicit resolution: the hook's leftover work must not
    // become a fixup, and the ticket must not be accepted.
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(after.lastError).toContain("Unresolved hook");
    expect(after.tickets[0].anchor).toBe(anchor);
    expect(after.tickets[0].workHead).toBe(anchor);
    expect(after.tickets[0].commit).toBeUndefined();
    expect(after.tickets[0].status).toBe("blocked");
    expect(f.git("-C", after.worktree, "rev-list", "--count", `${anchor}..HEAD`)).toBe("0");
    // The hook's work is still preserved.
    expect(readFileSync(join(after.worktree, "feature.txt"), "utf8")).toContain("dirty");
  },
  30_000,
);

cliTest(
  "resumes after a dirty hook once the operator commits the preserved work",
  async () => {
    const f = fixture();
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nif [ ! -f "${join(f.root, "hook-dirtied-once")}" ]; then\n  touch "${join(f.root, "hook-dirtied-once")}"\n  echo dirty >> feature.txt\nfi\n`,
      { mode: 0o755 },
    );
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    // The operator explicitly commits the hook's preserved work.
    f.git("-C", blocked.worktree, "add", "-A");
    f.git("-C", blocked.worktree, "commit", "-m", "Manual resolution of hook leftovers");
    const manual = f.git("-C", blocked.worktree, "rev-parse", "HEAD");
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    // Acceptance records the operator's commit; the controller adds no fixup.
    expect(finished.tickets[0].commit).toBe(manual);
    expect(finished.tickets[0].workHead).toBe(manual);
    expect(finished.tickets[0].repairCommits).toBeUndefined();
  },
  30_000,
);

cliTest(
  "preserves staged work and stops for recovery when commit signing is misconfigured",
  async () => {
    const f = fixture("blocked-review");
    f.git("config", "commit.gpgsign", "true");
    f.git("config", "gpg.program", join(f.root, "missing-gpg"));
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.lastError).toMatch(/gpg failed to sign|failed to write commit object/);
    expect(state.tickets[0].anchor).toBeUndefined();
    // Hooks were never bypassed and the staged work survives the rejection.
    expect(f.git("-C", state.worktree, "diff", "--cached", "--name-only")).toContain("feature.txt");
    // Repairing the configuration lets a later resume commit the same work.
    f.git("config", "--unset", "commit.gpgsign");
    f.git("config", "--unset", "gpg.program");
    const resumed = await f.run("resume", runDir);
    // The blocked review still stops the run, but the commit is recovered.
    expect(resumed.status).toBe(1);
    const after = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(after.tickets[0].anchor).toMatch(/^[a-f0-9]{40}$/);
    expect(after.tickets[0].repairs).toBe(0);
    expect(after.tickets[0].commit).toBeUndefined();
  },
  30_000,
);

cliTest(
  "stops for recovery when SSH commit signing is unconfigured",
  async () => {
    const f = fixture("blocked-review");
    f.git("config", "commit.gpgsign", "true");
    f.git("config", "gpg.format", "ssh");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.lastError).toContain("signingkey");
    // A signing configuration error is not a proven code defect: no repair round
    // is spent and the staged work survives for operator recovery.
    expect(state.tickets[0].repairs).toBe(0);
    expect(state.tickets[0].anchor).toBeUndefined();
    expect(f.git("-C", state.worktree, "diff", "--cached", "--name-only")).toContain("feature.txt");
  },
  30_000,
);

cliTest(
  "preserves a pending commit when a post-commit hook exceeds the Git deadline",
  async () => {
    const f = fixture("pass");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "post-commit"), `#!/bin/sh\nsleep 5\n`, { mode: 0o755 });
    const settingsDir = join(f.root, "deadline-settings");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "loop-settings.json");
    writeFileSync(settingsPath, JSON.stringify({ deadlines: { gitMs: 500 } }), "utf8");
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`,
      "--settings",
      settingsPath,
    );
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    // Git created the commit, but the post-commit hook outlasted the deadline:
    // the intent is retained for reconciliation instead of being discarded.
    expect(state.pendingCommit).toBeDefined();
    expect(state.tickets[0].anchor).toBeUndefined();
    const head = f.git("-C", state.worktree, "rev-parse", "HEAD");
    expect(head).not.toBe(state.baseSha);
    expect(f.git("-C", state.worktree, "log", "-1", "--format=%s")).toBe("loop: #11 Ticket 11");
    // Resume reconciles the recorded operation instead of duplicating it.
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.pendingCommit).toBeUndefined();
    expect(finished.tickets[0].anchor).toBe(head);
    expect(f.git("-C", finished.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe(
      "1",
    );
  },
  30_000,
);

cliTest(
  "reconciles a dirty post-commit crash without duplicating or auto-committing",
  async () => {
    const f = fixture("pass");
    const { runDir, worktree, state } = await startThenKillAfterCommit(
      f,
      "echo dirty >> feature.txt\n",
    );
    expect(state.pendingCommit).toBeDefined();
    const head = f.git("-C", worktree, "rev-parse", "HEAD");
    expect(head).not.toBe(state.baseSha);
    rmSync(join(runDir, "run.lock"), { force: true });
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    // The recovered commit is recorded once and its dirty hook leftovers are
    // preserved under an unresolved hook stop rather than committed as a fixup.
    expect(after.pendingCommit).toBeUndefined();
    expect(after.tickets[0].anchor).toBe(head);
    expect(after.tickets[0].hookStop).toBeDefined();
    expect(after.lastError).toContain("left uncommitted changes");
    expect(readFileSync(join(after.worktree, "feature.txt"), "utf8")).toContain("dirty");
    expect(f.git("-C", after.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe("1");
    // An unchanged later resume keeps the leftovers refused instead of turning
    // them into a fixup, even though the commit is already recorded.
    const again = await f.run("resume", runDir);
    expect(again.status).toBe(1);
    const stillBlocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(stillBlocked.lastError).toContain("Unresolved hook");
    expect(
      f.git("-C", stillBlocked.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`),
    ).toBe("1");
  },
  30_000,
);

cliTest(
  "records a bounded combined commit log for a rejected hook",
  async () => {
    const f = fixture("hook-repair");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nif [ ! -f hook-fixed.txt ]; then\n  echo "feature.txt:1:1 error: STDOUT_DIAGNOSTIC"\n  echo "feature.txt:1:2 error: STDERR_DIAGNOSTIC" >&2\n  exit 1\nfi\n`,
      { mode: 0o755 },
    );
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const repair = readWorkers(f.root).find((worker) => worker.name.includes("#11 repair"))!;
    // The repairer gets both the combined diagnostic and a durable log path.
    expect(repair.prompt).toContain("STDOUT_DIAGNOSTIC");
    expect(repair.prompt).toContain("STDERR_DIAGNOSTIC");
    const logPath = repair.prompt.match(/Log: (.+)/)![1].trim();
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("STDERR_DIAGNOSTIC");
  },
  30_000,
);

cliTest.each([
  ["source diagnostic", "feature.txt:1:1 error: Unexpected token"],
  ["TypeScript diagnostic", "feature.ts(1,1): error TS2322: Type mismatch"],
  ["Biome lint diagnostic", "feature.ts:1:7 lint/correctness/noUnusedVariables  FIXABLE"],
  ["Biome formatting diagnostic", "Formatter would have printed the following content:"],
  ["test assertion", "AssertionError: expected 1 to be 2"],
  ["Rust diagnostic", "error[E0308]: mismatched types"],
])(
  "returns an actionable hook failure to the last editing session and spends a repair round (%s)",
  async (_label, diagnostic) => {
    const f = fixture("hook-repair");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nif [ ! -f hook-fixed.txt ]; then\n  echo "${diagnostic}" >&2\n  exit 1\nfi\n`,
      { mode: 0o755 },
    );
    const result = await f.start();
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = state.tickets[0];
    expect(ticket.status).toBe("accepted");
    expect(ticket.repairs).toBe(1);
    const workers = readWorkers(f.root).filter((worker) => worker.name.includes("#11 "));
    const implement = workers.find((worker) => worker.name.includes("implement"))!;
    const repair = workers.find((worker) => worker.name.includes("repair"))!;
    // The hook defect returned to the last editing conversation, not a fresh one.
    expect(repair.session).toBe(implement.session);
    expect(repair.prompt).toContain("Commit hooks rejected the work");
    expect(repair.prompt).toContain(diagnostic);
    // Hooks were never bypassed: the anchor commit contains the repair.
    expect(f.git("-C", state.worktree, "show", `${ticket.anchor}:hook-fixed.txt`)).toContain(
      "fixed",
    );
    // A fresh independent reviewer assessed the repaired artifact.
    const review = workers.find((worker) => worker.name.includes("review"))!;
    expect(review.session).not.toBe(implement.session);
    expect(ticket.review).toMatchObject({ outcome: "pass" });
  },
  30_000,
);

cliTest(
  "returns a failed recheck of a clean hook mutation to the last editing session",
  async () => {
    const f = fixture("hook-mutation-repair");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    // A formatter-style hook appends to the staged file and commits it once.
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nif [ ! -f "${join(f.root, "hook-mutated-once")}" ]; then\n  touch "${join(f.root, "hook-mutated-once")}"\n  echo mutated >> feature.txt\n  git add feature.txt\nfi\n`,
      { mode: 0o755 },
    );
    // Passes before the hook, fails on the hook-mutated committed tree, then
    // passes once the repairer removes the injected content.
    const check = `${JSON.stringify(process.execPath)} -e "const fs=require('node:fs');process.exit(fs.readFileSync('feature.txt','utf8').includes('mutated')?1:0)"`;
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", check);
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = state.tickets[0];
    expect(ticket.status).toBe("accepted");
    // The failed recheck spent exactly one repair round and returned to the editor.
    expect(ticket.repairs).toBe(1);
    const workers = readWorkers(f.root).filter((worker) => worker.name.includes("#11 "));
    const implement = workers.find((worker) => worker.name.includes("implement"))!;
    const repair = workers.find((worker) => worker.name.includes("repair"))!;
    expect(repair.session).toBe(implement.session);
    expect(repair.prompt).toContain(
      "Checks failed after a successful hook changed the committed tree",
    );
    // A fresh independent reviewer assessed the repaired artifact.
    const review = workers.find((worker) => worker.name.includes("review"))!;
    expect(review.session).not.toBe(implement.session);
    expect(ticket.review).toMatchObject({ outcome: "pass" });
    // The hook mutation is gone from the accepted tree.
    expect(f.git("-C", state.worktree, "show", `${ticket.commit}:feature.txt`)).not.toContain(
      "mutated",
    );
  },
  30_000,
);

cliTest.each([
  ["a missing tool", `echo "pnpm: command not found" >&2`],
  ["a missing hook interpreter", "", "/nonexistent/issue-loop-hook-interpreter"],
  ["a missing linker", "echo 'error: linker `cc` not found' >&2"],
  [
    "a missing hook interpreter diagnostic",
    `echo "error: cannot run .git/hooks/pre-commit: No such file or directory" >&2`,
  ],
  [
    "a missing tool after a source diagnostic",
    `echo "feature.ts:1:1 error: Unexpected token"; echo "pnpm: command not found" >&2`,
  ],
  [
    "a missing tool before long compiler output",
    `echo "pnpm: command not found" >&2
    i=0
    while [ "$i" -lt 100 ]; do
      echo "feature.ts:1:1 error: Unexpected token" >&2
      i=$((i+1))
    done`,
  ],
  [
    "a missing shell command after a source diagnostic",
    `echo "feature.ts:1:1 error: Unexpected token"; echo "pre-commit: 1: pnpm: not found" >&2`,
  ],
  [
    "a runner startup failure",
    `echo "FAIL tests/example.test.ts"; echo "Error: Cannot find package 'vitest'" >&2`,
  ],
  ["an unclassified error count", `echo "Found 1 error" >&2`],
  ["an unclassified failure symbol", `echo "✖ Hook setup failed" >&2`],
  ["an unrecognized diagnostic", `echo "STDOUT_DIAGNOSTIC"; echo "STDERR_DIAGNOSTIC" >&2`],
])(
  "stops for recovery on %s without spending a repair round",
  async (_label, diagnostic, interpreter = "/bin/sh") => {
    const f = fixture("hook-repair");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), `#!${interpreter}\n${diagnostic}\nexit 1\n`, {
      mode: 0o755,
    });
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    // Unclassified hook output is not proof of a code defect: no repair worker
    // launched, no repair round consumed, and the staged work is preserved.
    expect(state.status).toBe("blocked");
    expect(state.lastError).toContain("Git hooks rejected the work commit");
    expect(state.tickets[0].repairs).toBe(0);
    expect(state.tickets[0].anchor).toBeUndefined();
    expect(readWorkers(f.root).some((worker) => worker.name.includes("repair"))).toBe(false);
    expect(f.git("-C", state.worktree, "rev-parse", "HEAD")).toBe(state.tickets[0].baseline);
    expect(f.git("-C", state.worktree, "diff", "--cached", "--name-only")).toContain("feature.txt");
  },
  30_000,
);

cliTest(
  "records stable run and step trailers on feature and fixup commits",
  async () => {
    const f = fixture("fixup");
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "true");
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const ticket = state.tickets[0];
    const show = (format: string, sha: string) =>
      f.git("-C", state.worktree, "log", "-1", format, sha);
    // A readable feature subject with a stable run/step trailer.
    expect(show("--format=%s", ticket.anchor)).toBe("loop: #11 Ticket 11");
    const anchorBody = show("--format=%B", ticket.anchor);
    expect(anchorBody).toContain(`Loop-Run: ${state.name}`);
    expect(anchorBody).toContain("Loop-Step: #11-implement-1");
    // Later repairs are standard fixups targeting the anchor, same trailers.
    const fixup = ticket.repairCommits[0];
    expect(show("--format=%s", fixup)).toBe("fixup! loop: #11 Ticket 11");
    const fixupBody = show("--format=%B", fixup);
    expect(fixupBody).toContain(`Loop-Run: ${state.name}`);
    expect(fixupBody).toContain("Loop-Step: #11-repair-1");
  },
  30_000,
);

cliTest(
  "recovers a crash after Git created the commit without duplicating it",
  async () => {
    const f = fixture("pass");
    const { runDir, worktree, state } = await startThenKillAfterCommit(f);
    // The intent was persisted before Git; the commit was never recorded.
    expect(state.pendingCommit).toBeDefined();
    expect(state.tickets[0].anchor).toBeUndefined();
    const head = f.git("-C", worktree, "rev-parse", "HEAD");
    expect(head).not.toBe(state.baseSha);
    expect(f.git("-C", worktree, "log", "-1", "--format=%s")).toBe("loop: #11 Ticket 11");
    // The controller was killed; remove its stale lock as documented.
    rmSync(join(runDir, "run.lock"), { force: true });
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(finished.status).toBe("done");
    expect(finished.pendingCommit).toBeUndefined();
    expect(finished.tickets[0].anchor).toBe(head);
    // Recovery recorded the existing commit instead of making another.
    expect(f.git("-C", finished.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe(
      "1",
    );
  },
  30_000,
);

cliTest(
  "blocks on an ambiguous pending commit with diagnostics and preserved work",
  async () => {
    const f = fixture("pass");
    const { runDir, worktree } = await startThenKillAfterCommit(f);
    // The operator rewrites the unrecorded commit so it no longer proves the operation.
    f.git("-C", worktree, "commit", "--amend", "-m", "operator overwrite");
    rmSync(join(runDir, "run.lock"), { force: true });
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const after = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(after.lastError).toContain("Unverified pending commit");
    expect(after.tickets[0].anchor).toBeUndefined();
    expect(after.tickets[0].commit).toBeUndefined();
    // The operator's work is preserved rather than overwritten or duplicated.
    expect(f.git("-C", after.worktree, "log", "-1", "--format=%s")).toBe("operator overwrite");
  },
  30_000,
);

cliTest(
  "refuses a verdict when the read-only review edits the artifact",
  async () => {
    const f = fixture("review-edit");
    const result = await f.start();
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.lastError).toContain("changed the worktree");
    expect(state.tickets[0].status).toBe("blocked");
    expect(state.tickets[0].review).toBeUndefined();
    expect(readFileSync(join(state.worktree, "feature.txt"), "utf8")).toContain("tampered");
  },
  30_000,
);

cliTest(
  "keeps failed-check work uncommitted and preserves it for repair",
  async () => {
    const f = fixture();
    const result = await f.run("start", "--repo", f.repo, "--issue", "10", "--check", "false");
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.tickets[0].anchor).toBeUndefined();
    expect(state.tickets[0].commit).toBeUndefined();
    expect(f.git("-C", state.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe("0");
    // The worker's changes survive outside a commit.
    expect(existsSync(join(state.worktree, "feature.txt"))).toBe(true);
  },
  30_000,
);

it("derives the GitHub host from common origin URL forms", () => {
  expect(githubHostFromOrigin("git@github.com:owner/repo.git")).toBe("github.com");
  expect(githubHostFromOrigin("git@ghe.example.com:owner/repo.git")).toBe("ghe.example.com");
  expect(githubHostFromOrigin("https://github.com/owner/repo.git")).toBe("github.com");
  expect(githubHostFromOrigin("https://ghe.example.com/owner/repo")).toBe("ghe.example.com");
  expect(githubHostFromOrigin("ssh://git@ghe.example.com/owner/repo.git")).toBe("ghe.example.com");
  expect(githubHostFromOrigin("/tmp/remote.git")).toBeUndefined();
});

it("rejects a gh call when the inherited GH_HOST targets another host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-loop-gh-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const saved = process.env.GH_HOST;
  process.env.GH_HOST = "other.example.com";
  try {
    await expect(gh(dir, "github.com", "api", "x")).rejects.toThrow("GH_HOST");
  } finally {
    if (saved === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = saved;
  }
});

it("forces the origin host on gh calls instead of inheriting the environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-loop-gh-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "env.txt");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$GH_HOST" > "$STUB_OUT"\nprintf '{}\\n'\n`, {
    mode: 0o755,
  });
  const savedPath = process.env.PATH;
  const savedGhHost = process.env.GH_HOST;
  const savedStubOut = process.env.STUB_OUT;
  process.env.PATH = `${dir}:${savedPath}`;
  process.env.STUB_OUT = out;
  try {
    delete process.env.GH_HOST;
    expect(await gh(dir, "github.com", "api", "x")).toBe("{}");
    expect(readFileSync(out, "utf8").trim()).toBe("github.com");
    process.env.GH_HOST = "github.com";
    expect(await gh(dir, "github.com", "api", "x")).toBe("{}");
    process.env.GH_HOST = "ghe.example.com";
    expect(await gh(dir, undefined, "api", "x")).toBe("{}");
    expect(readFileSync(out, "utf8").trim()).toBe("ghe.example.com");
  } finally {
    process.env.PATH = savedPath!;
    if (savedGhHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = savedGhHost;
    if (savedStubOut === undefined) delete process.env.STUB_OUT;
    else process.env.STUB_OUT = savedStubOut;
  }
});

it("normalizes an empty agent tools list to the role defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "issue-loop-settings-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "agents"), { recursive: true });
  for (const role of ["implement", "review"]) {
    writeFileSync(
      join(dir, "agents", `${role}.md`),
      `---\ndescription: Test ${role}\nmodel: test-provider/model\ntools: []\n---\n\nGuidance.`,
      "utf8",
    );
  }
  writeFileSync(
    join(dir, "loop-settings.json"),
    JSON.stringify({
      implementAgent: "./agents/implement.md",
      reviewAgent: "./agents/review.md",
    }),
    "utf8",
  );
  const settings = loadLoopSettings(join(dir, "loop-settings.json"));
  expect(settings.implement.tools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
  expect(settings.review.tools).toEqual(["read", "grep", "find", "ls"]);
});

cliTest("leaves a replaced run lock for its new owner", async () => {
  const f = fixture("replace-lock");
  const result = await f.start();
  expect(result.status, result.stderr).toBe(0);
  const runDir = result.stdout.match(/Run directory: (.+)/)![1];
  expect(readFileSync(join(runDir, "run.lock"), "utf8")).toBe("new-owner\n");
  expect(result.stderr).toContain("replaced");
});

cliTest(
  "can resume a setup failure in the already-created worktree",
  async () => {
    const f = fixture();
    const setup = `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('setup-ready')"`;
    const first = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--setup",
      setup,
    );
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    writeFileSync(join(state.worktree, "setup-ready"), "ready");
    // Setup artifacts would normally be ignored dependency directories.
    writeFileSync(join(f.root, "ignore"), "setup-ready\n");
    f.git("config", "core.excludesFile", join(f.root, "ignore"));
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
  },
  30_000,
);

function writeWatchdogSettings(root: string, silenceMs = 100): string {
  const settingsPath = join(root, "watchdog-settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      watchdog: {
        silenceMs,
        toolMs: 100_000,
        softCheckpointMs: 100_000,
        hardCeilingMs: 100_000,
        checkpointGraceMs: 100,
        abortGraceMs: 100,
        sigkillEscalationMs: 100,
      },
      recovery: { transientRetries: 2, transientBackoffMs: [1, 1] },
    }),
    "utf8",
  );
  return settingsPath;
}

cliTest(
  "checkpoints and aborts a stalled worker while persisting the stop explanation",
  async () => {
    const f = fixture("stall-review");
    const settingsPath = writeWatchdogSettings(f.root);
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(result.status, result.stderr).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.status).toBe("blocked");
    const review = state.sessions.find((session: { name: string }) =>
      session.name.includes("review"),
    );
    expect(review.stopReason).toContain("checkpoint-grace");
    expect(review.consumedMs).toBeGreaterThanOrEqual(100);
    // The specific stalled-step evidence is persisted, not just the abort reason.
    expect(review.checkpoint).toMatchObject({ reason: "silence" });
    expect(review.checkpoint.detail).toContain("no observable progress");
    expect(state.lastError).toContain("checkpoint-grace");
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("checkpoint-grace");
    // The checkpoint request was delivered before the abort.
    const reviewCommands = readWorkers(f.root).filter((entry) => entry.name.includes("review"));
    expect(reviewCommands.some((entry) => entry.prompt?.includes("Controller checkpoint"))).toBe(
      true,
    );
  },
  30_000,
);

cliTest(
  "makes no work commit for an incomplete watchdog checkpoint",
  async () => {
    const f = fixture("stall-implement");
    const settingsPath = writeWatchdogSettings(f.root);
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(result.status, result.stderr).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.status).toBe("blocked");
    expect(state.tickets[0].anchor).toBeUndefined();
    expect(state.tickets[0].commit).toBeUndefined();
    expect(f.git("-C", state.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe("0");
  },
  30_000,
);

cliTest(
  "does not commit an interrupted editing phase's saved files on resume",
  async () => {
    const f = fixture("stall-after-write");
    const settingsPath = writeWatchdogSettings(f.root);
    const args = [
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    ];
    const first = await f.run(...args);
    expect(first.status, first.stderr).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const afterFirst = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    // The interrupted worker's saved file is preserved but uncommitted.
    expect(existsSync(join(afterFirst.worktree, "feature.txt"))).toBe(true);
    expect(afterFirst.tickets[0].anchor).toBeUndefined();
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(1);
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    // Resuming unchanged must not turn the leftover file into a work commit.
    expect(state.tickets[0].anchor).toBeUndefined();
    expect(state.tickets[0].commit).toBeUndefined();
    expect(f.git("-C", state.worktree, "rev-list", "--count", `${state.baseSha}..HEAD`)).toBe("0");
    // The uncommitted artifact was still reviewed as HEAD plus its content tree,
    // with the untracked file in the cumulative patch.
    expect(state.tickets[0].review).toMatchObject({ outcome: "pass", head: state.baseSha });
    expect(state.tickets[0].review.tree).toMatch(/^[a-f0-9]{40}$/);
    expect(state.tickets[0].review.tree).not.toBe(
      f.git("-C", state.worktree, "rev-parse", `${state.baseSha}^{tree}`),
    );
    const patch = readFileSync(join(runDir, "review.patch"), "utf8");
    expect(patch).toContain("feature.txt");
    expect(patch).toContain("partial");
  },
  30_000,
);

cliTest(
  "reuses consumed watchdog runtime when resuming an interrupted review",
  async () => {
    const f = fixture("stall-review");
    const settingsPath = writeWatchdogSettings(f.root);
    const args = [
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    ];
    const first = await f.run(...args);
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const afterFirst = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const attemptOne = afterFirst.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 1"),
    );
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const afterResume = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const attemptTwo = afterResume.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 2"),
    );
    expect(attemptOne.consumedMs).toBeGreaterThanOrEqual(100);
    expect(attemptTwo.consumedMs).toBeGreaterThan(attemptOne.consumedMs + 50);
    expect(attemptTwo.continuationUsed).toBe(false);
    // The recovery prompt replays the persisted checkpoint evidence so an
    // unconsumed steer is not the only record.
    const attemptTwoWorkers = readWorkers(f.root).filter((entry) =>
      entry.name.includes("review · attempt 2"),
    );
    expect(attemptTwoWorkers.some((entry) => entry.prompt.includes("Recovery context"))).toBe(true);
    expect(attemptTwoWorkers.some((entry) => entry.prompt.includes("no observable progress"))).toBe(
      true,
    );
  },
  30_000,
);

cliTest(
  "inherits recovery state when resume startup is interrupted before accounting",
  async () => {
    const f = fixture("stall-review");
    const settingsPath = writeWatchdogSettings(f.root);
    const args = [
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    ];
    const first = await f.run(...args);
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const statePath = join(runDir, "state.json");
    const afterFirst = JSON.parse(readFileSync(statePath, "utf8"));
    const attemptOne = afterFirst.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 1"),
    );
    expect(attemptOne.consumedMs).toBeGreaterThanOrEqual(100);
    expect(attemptOne.checkpoint).toMatchObject({ reason: "silence" });
    // Interrupt the controller after it persists the new attempt but before the
    // worker can report any accounting. A directory at the log path makes the
    // worker fail to start without touching the restored state.
    const nextLog = join(runDir, "logs", `${afterFirst.sessions.length + 1}-review.log`);
    mkdirSync(nextLog, { recursive: true });
    const interrupted = await f.run("resume", runDir);
    expect(interrupted.status).toBe(1);
    const afterInterrupt = JSON.parse(readFileSync(statePath, "utf8"));
    const attemptTwo = afterInterrupt.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 2"),
    );
    // The interrupted attempt must inherit the allowance and evidence, not
    // reset them, because it is now the latest recovery source.
    expect(attemptTwo.consumedMs).toBe(attemptOne.consumedMs);
    expect(attemptTwo.continuationUsed).toBe(false);
    expect(attemptTwo.checkpoint).toMatchObject({ reason: "silence" });
    expect(attemptTwo.outcome).toBeUndefined();
    rmSync(nextLog, { recursive: true, force: true });
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const finished = JSON.parse(readFileSync(statePath, "utf8"));
    const attemptThree = finished.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 3"),
    );
    expect(attemptThree.consumedMs).toBeGreaterThanOrEqual(attemptTwo.consumedMs);
  },
  30_000,
);

cliTest(
  "reuses consumed runtime after an unsuccessful exit, not only a watchdog abort",
  async () => {
    const f = fixture("fail-review-after-delay");
    const first = await f.start();
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const afterFirst = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const attemptOne = afterFirst.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 1"),
    );
    expect(attemptOne.consumedMs).toBeGreaterThanOrEqual(200);
    f.env.FIXTURE_MODE = "pass";
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const afterResume = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const attemptTwo = afterResume.sessions.find((session: { name: string }) =>
      session.name.includes("review · attempt 2"),
    );
    // The resumed review inherits the runtime already spent by the crashed one.
    expect(attemptTwo.consumedMs).toBeGreaterThan(attemptOne.consumedMs);
  },
  30_000,
);

cliTest(
  "starts a fresh review task after a repair instead of reusing an obsolete interrupted review",
  async () => {
    const f = fixture("stall-once");
    const settingsPath = writeWatchdogSettings(f.root);
    const first = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const resumed = await f.run("resume", runDir);
    expect(resumed.status, resumed.stderr).toBe(0);
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const reviews = state.sessions.filter((session: { name: string }) =>
      session.name.includes("#11 review"),
    );
    expect(reviews).toHaveLength(3);
    const [interrupted, repaired, fresh] = reviews;
    expect(interrupted.outcome).toBeUndefined();
    expect(repaired.outcome).toBe("changes_requested");
    expect(fresh.outcome).toBe("pass");
    // A completed review ends the phase task; the next review must not inherit
    // the obsolete interrupted attempt's consumed allowance.
    expect(fresh.consumedMs).toBeLessThan(interrupted.consumedMs);
  },
  30_000,
);

cliTest(
  "recovers a transient execution failure within the controller budget",
  async () => {
    const f = fixture("recover-transient");
    const settingsPath = writeWatchdogSettings(f.root, 100_000);
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.status).toBe("done");
    const implement = state.sessions.find((session: { name: string }) =>
      session.name.includes("#11 implement"),
    );
    expect(implement.transientRetries).toBe(1);
    expect(implement.outcome).toBe("complete");
    // Recovery does not consume a child code-repair round.
    expect(state.tickets[0].repairs).toBe(0);
    // The retry prompt replayed the failure and warned against blind repetition.
    const prompts = readWorkers(f.root)
      .filter((worker) => worker.name.includes("#11 implement"))
      .map((worker) => worker.prompt);
    expect(
      prompts.some((prompt) => prompt.includes("transient") && prompt.includes("blindly")),
    ).toBe(true);
  },
  30_000,
);

cliTest(
  "bounds transient recovery and keeps the exhausted count across resume",
  async () => {
    const f = fixture("recover-exhausted");
    const settingsPath = writeWatchdogSettings(f.root, 100_000);
    const args = [
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      `${JSON.stringify(process.execPath)} -e "require('node:fs').accessSync('feature.txt')"`,
      "--settings",
      settingsPath,
    ];
    const first = await f.run(...args);
    expect(first.status).toBe(1);
    const runDir = first.stdout.match(/Run directory: (.+)/)![1];
    const blocked = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(blocked.status).toBe("blocked");
    expect(blocked.lastError).toContain("transient retries were exhausted");
    const attemptOne = blocked.sessions.find((session: { name: string }) =>
      session.name.includes("#11 implement"),
    );
    expect(attemptOne.transientRetries).toBe(2);
    // Execution recovery is separate from a code repair.
    expect(blocked.tickets[0].repairs).toBe(0);
    // Resume does not replenish the budget: the next transient failure stops
    // immediately without another retry prompt.
    const resumed = await f.run("resume", runDir);
    expect(resumed.status).toBe(1);
    const afterResume = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    const attemptTwo = afterResume.sessions.find((session: { name: string }) =>
      session.name.includes("#11 implement · attempt 2"),
    );
    expect(attemptTwo.transientRetries).toBe(2);
    // Repeated infrastructure-failure resumes never spend the repair budget.
    expect(afterResume.tickets[0].repairs).toBe(0);
    // Resume does not replenish the budget, so the new attempt sends no retry.
    const attemptTwoPrompts = readWorkers(f.root).filter((worker) =>
      worker.name.includes("#11 implement · attempt 2"),
    );
    expect(
      attemptTwoPrompts.some(
        (worker) =>
          worker.prompt?.includes("Recovery context") && worker.prompt?.includes("transient"),
      ),
    ).toBe(true);
    const retryPrompts = attemptTwoPrompts.filter((worker) =>
      worker.prompt?.includes("exhausted its native provider retries"),
    );
    expect(retryPrompts).toHaveLength(0);
    // Once the environment is fixed, a later resume completes the run.
    f.env.FIXTURE_MODE = "pass";
    const finished = await f.run("resume", runDir);
    expect(finished.status, finished.stderr).toBe(0);
    const afterFinish = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(afterFinish.status).toBe("done");
    expect(afterFinish.tickets[0].repairs).toBe(0);
  },
  60_000,
);

cliTest(
  "corrects one malformed response instead of blocking the run",
  async () => {
    const f = fixture("recover-correction");
    const settingsPath = writeWatchdogSettings(f.root, 100_000);
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(result.status, result.stderr).toBe(0);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.status).toBe("done");
    const implement = state.sessions.find((session: { name: string }) =>
      session.name.includes("#11 implement"),
    );
    expect(implement.corrections).toBe(1);
    expect(implement.outcome).toBe("complete");
    // The correction attempt does not consume a child code-repair round.
    expect(state.tickets[0].repairs).toBe(0);
    const prompts = readWorkers(f.root).filter((worker) => worker.name.includes("#11 implement"));
    expect(prompts.some((worker) => worker.prompt.includes("could not accept"))).toBe(true);
  },
  30_000,
);

cliTest(
  "does not spend a transient retry on an unclassified execution failure",
  async () => {
    const f = fixture("fail");
    const settingsPath = writeWatchdogSettings(f.root, 100_000);
    const result = await f.run(
      "start",
      "--repo",
      f.repo,
      "--issue",
      "10",
      "--check",
      "true",
      "--settings",
      settingsPath,
    );
    expect(result.status).toBe(1);
    const runDir = result.stdout.match(/Run directory: (.+)/)![1];
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].transientRetries ?? 0).toBe(0);
    expect(state.lastError).toContain("Provider unavailable");
  },
  30_000,
);
