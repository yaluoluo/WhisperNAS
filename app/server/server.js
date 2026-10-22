const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 5001;
const SOCKET_PATH = process.env.SOCKET_PATH || '';
const PREFIX = process.env.GATEWAY_PREFIX || '/app/whispernas';
const ROOT = path.resolve(__dirname, '..');
const WHISPER_ROOT = path.join(ROOT, 'whisper.cpp-1.9.5');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const MODEL_DIR = path.join(DATA_DIR, 'models');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const DB_FILE = path.join(DATA_DIR, 'jobs.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ALLOWED = new Set(['.mp4','.mkv','.avi','.mov','.wmv','.flv','.webm','.m4v','.ts','.mpg','.mpeg','.mp3','.wav','.m4a','.aac','.flac','.ogg','.opus','.wma']);
for (const d of [DATA_DIR, MEDIA_DIR, MODEL_DIR, TMP_DIR]) fs.mkdirSync(d, {recursive:true});
app.use(express.json({limit:'30mb'}));
app.use(express.urlencoded({extended:false}));
app.use(PREFIX, express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req,res,next)=>{ if(req.url.startsWith(PREFIX+'/api')) req.url=req.url.slice(PREFIX.length); next(); });

let jobs = [];
let running = false;
let activeChild = null;
let settings = { vulkan: true, device: '', language: 'zh', suppressNonSpeech: true };
try {
  const savedJobs = JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
  if (Array.isArray(savedJobs)) jobs = savedJobs;
} catch {}
try { settings = {...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8'))}; } catch {}
for (const j of jobs) {
  if (['extracting','transcribing'].includes(j.status)) {
    j.status='queued';
    j.progress=0;
    j.stage='服务重启后等待继续';
  }
}
try { fs.writeFileSync(DB_FILE, JSON.stringify(jobs,null,2)); } catch {}
function saveJobs(){ fs.writeFileSync(DB_FILE, JSON.stringify(jobs,null,2)); }
function saveSettings(){ fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings,null,2)); }
function id(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function statFile(p){ try { const s=fs.statSync(p); return {size:s.size,mtime:s.mtime}; } catch { return null; } }
function isMedia(p){ return ALLOWED.has(path.extname(p).toLowerCase()); }
function walk(p, out=[], depth=0){ if(depth>20)return out; let list; try{list=fs.readdirSync(p,{withFileTypes:true});}catch{return out;} for(const e of list){ const q=path.join(p,e.name); if(e.isDirectory())walk(q,out,depth+1); else if(e.isFile()&&isMedia(q))out.push(q); } return out; }
function addJob(file, originalName){
  const existing = jobs.find(j => j.filePath === file && ['queued','extracting','transcribing'].includes(j.status));
  if(existing) return existing;
  const base = file.slice(0, file.length - path.extname(file).length);
  const j = {id:id(), name:path.basename(file), originalName:originalName||path.basename(file), filePath:file, srtPath:base+'.srt', status:fs.existsSync(base+'.srt')?'done':'queued', progress:fs.existsSync(base+'.srt')?100:0, stage:fs.existsSync(base+'.srt')?'已存在字幕':'等待处理', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), error:'', log:''};
  jobs.unshift(j); saveJobs(); return j;
}
function update(j, fields){ Object.assign(j,fields,{updatedAt:new Date().toISOString()}); saveJobs(); }
function runProcess(bin,args,opts,onLine){ return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd:opts.cwd,env:{...process.env,LD_LIBRARY_PATH:path.join(WHISPER_ROOT,'lib')+':'+(process.env.LD_LIBRARY_PATH||'')}}); activeChild=child;
  let tail=''; const collect=(chunk)=>{ tail+=chunk.toString(); const lines=tail.split(/\r?\n/); tail=lines.pop()||''; for(const line of lines)onLine(line); };
  child.stdout.on('data',collect); child.stderr.on('data',collect);
  child.on('error',e=>{activeChild=null;reject(e)});
  child.on('close',(code,signal)=>{ if(tail)onLine(tail); activeChild=null; code===0?resolve():reject(new Error(`${path.basename(bin)} 退出，code=${code}, signal=${signal||''}`)); });
 }); }
async function processJob(j){
  const modelName=settings.model || ''; const modelPath=path.join(MODEL_DIR,modelName);
  if(!modelName || !fs.existsSync(modelPath)) throw new Error('未找到模型，请先在“模型”页面选择 models 目录中的模型文件');
  if(!fs.existsSync(j.filePath)) throw new Error('源文件不存在或不可访问：'+j.filePath);
  const wav=path.join(TMP_DIR,j.id+'.wav');
  update(j,{status:'extracting',progress:2,stage:'FFmpeg 提取 16kHz 单声道 WAV',error:'',log:''});
  await runProcess(process.env.FFMPEG_PATH||'ffmpeg',['-y','-i',j.filePath,'-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav],{cwd:ROOT},line=>{ j.log=(j.log+'\n'+line).slice(-12000); update(j,{progress:Math.min(10, j.progress+0.2),log:j.log}); });
  update(j,{status:'transcribing',progress:10,stage:'Whisper 正在转写',log:j.log});
  const args=['-l',settings.language||'zh','-osrt']; if(settings.suppressNonSpeech!==false)args.push('--suppress-nst');
  args.push('-pp','-m',modelPath,'-f',wav,'-of',j.filePath.slice(0,j.filePath.length-path.extname(j.filePath).length));
  if(!settings.vulkan)args.push('-ng');
  if(settings.vulkan && settings.device && /^\d+$/.test(settings.device.trim()))args.push('-dev',settings.device.trim());
  let lastPct=10;
  await runProcess(path.join(WHISPER_ROOT,'bin','whisper-cli'),args,{cwd:WHISPER_ROOT},line=>{
    j.log=(j.log+'\n'+line).slice(-12000);
    const m=line.match(/(?:^|\s)(\d{1,3})%/); if(m)lastPct=Math.max(lastPct,Math.min(98,10+Math.floor(Number(m[1])*.88)));
    update(j,{progress:lastPct,stage:'Whisper 正在转写',log:j.log});
  });
  try{fs.unlinkSync(wav)}catch{}
  if(!fs.existsSync(j.srtPath)) throw new Error('whisper-cli 已退出，但没有生成 SRT 文件；请检查日志和模型格式');
  update(j,{status:'done',progress:100,stage:'识别完成',error:'',finishedAt:new Date().toISOString()});
}
async function pump(){ if(running)return; if(!settings.model || !fs.existsSync(path.join(MODEL_DIR,settings.model)))return; running=true; try{ while(true){ const j=jobs.slice().reverse().find(x=>x.status==='queued'); if(!j)break; try{await processJob(j);}catch(e){update(j,{status:'error',stage:'处理失败',error:String(e.message||e)});} } } finally{running=false;} }
const upload = multer({dest:TMP_DIR, limits:{fileSize:50*1024*1024*1024, files:500}});
app.get('/api/state',(req,res)=>res.json({jobs,settings,models:listModels(),paths:{dataDir:DATA_DIR,modelDir:MODEL_DIR,mediaDir:MEDIA_DIR},runtime:{whisperCli:fs.existsSync(path.join(WHISPER_ROOT,'bin/whisper-cli')),ffmpeg:findFfmpeg(),vulkanLibrary:fs.existsSync(path.join(WHISPER_ROOT,'lib/libggml-vulkan.so.0')),active:!!activeChild}}));
function listModels(){ let files=[]; try{files=fs.readdirSync(MODEL_DIR,{withFileTypes:true}).filter(e=>e.isFile()&&/^ggml-.*\.(bin|gguf)$/i.test(e.name)).map(e=>{const p=path.join(MODEL_DIR,e.name);const s=statFile(p);return {name:e.name,size:s?.size||0,mtime:s?.mtime||null}});}catch{} return files; }
function findFfmpeg(){ try{execFileSync(process.env.FFMPEG_PATH||'ffmpeg',['-version'],{stdio:'ignore'});return process.env.FFMPEG_PATH||'ffmpeg';}catch{return null;} }
app.post('/api/import/upload',upload.array('files',500),(req,res)=>{
  const created=[]; for(const f of req.files||[]){ const safe=path.basename(f.originalname||f.filename).replace(/[\\/]/g,'_'); if(!isMedia(safe)){fs.unlink(f.path,()=>{});continue;} let dest=path.join(MEDIA_DIR,safe); if(fs.existsSync(dest)){const ext=path.extname(safe);dest=path.join(MEDIA_DIR,path.basename(safe,ext)+'-'+Date.now()+ext);} fs.renameSync(f.path,dest);created.push(addJob(dest,safe)); }
  pump();res.json({created:created.length,jobs:created});
});
app.post('/api/import/path',(req,res)=>{
  const inputs=Array.isArray(req.body.paths)?req.body.paths:[req.body.path]; const files=[]; const errors=[];
  for(const raw of inputs.filter(Boolean)){ const p=path.resolve(String(raw)); let s;try{s=fs.statSync(p)}catch{errors.push(`路径不可访问：${p}`);continue;} if(s.isDirectory())files.push(...walk(p));else if(s.isFile()&&isMedia(p))files.push(p);else errors.push(`不是支持的音视频文件或目录：${p}`); }
  const unique=[...new Set(files)];const created=unique.map(f=>addJob(f));pump();res.json({created:created.length,jobs:created,errors});
});
app.post('/api/jobs/:id/retry',(req,res)=>{const j=jobs.find(x=>x.id===req.params.id);if(!j)return res.status(404).json({error:'任务不存在'});if(!['error','done'].includes(j.status))return res.status(409).json({error:'当前状态不能重新处理'});update(j,{status:'queued',progress:0,stage:'等待处理',error:'',log:''});pump();res.json(j);});
app.delete('/api/jobs/:id',(req,res)=>{const i=jobs.findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).json({error:'任务不存在'});if(!['queued','done','error'].includes(jobs[i].status))return res.status(409).json({error:'正在处理的任务不能删除'});jobs.splice(i,1);saveJobs();res.json({ok:true});});
app.get('/api/jobs/:id/subtitle',(req,res)=>{const j=jobs.find(x=>x.id===req.params.id);if(!j)return res.status(404).json({error:'任务不存在'});if(!fs.existsSync(j.srtPath))return res.status(404).json({error:'字幕文件尚不存在'});res.type('text/plain; charset=utf-8').send(fs.readFileSync(j.srtPath,'utf8'));});
app.put('/api/jobs/:id/subtitle',(req,res)=>{const j=jobs.find(x=>x.id===req.params.id);if(!j)return res.status(404).json({error:'任务不存在'});if(typeof req.body.content!=='string')return res.status(400).json({error:'字幕内容格式错误'});fs.writeFileSync(j.srtPath,req.body.content,'utf8');update(j,{stage:'字幕已保存'});res.json({ok:true});});
app.put('/api/settings',(req,res)=>{const b=req.body||{};const device=String(b.device||'').trim();if(device&&!/^\d+$/.test(device))return res.status(400).json({error:'GPU 设备编号必须是非负整数'});const model=String(b.model||'');if(model&&!listModels().some(m=>m.name===model))return res.status(400).json({error:'所选模型不在 models 目录中'});settings={...settings,vulkan:b.vulkan!==false,device,model,language:'zh',suppressNonSpeech:b.suppressNonSpeech!==false};saveSettings();res.json(settings);if(!running)pump();});
app.get('/api/browse',(req,res)=>{const p=path.resolve(String(req.query.path||DATA_DIR));let s;try{s=fs.statSync(p)}catch{return res.status(400).json({error:'目录不存在或无权访问'});}if(!s.isDirectory())return res.status(400).json({error:'不是目录'});let entries=[];try{entries=fs.readdirSync(p,{withFileTypes:true}).filter(e=>e.isDirectory()||e.isFile()&&isMedia(e.name)).map(e=>({name:e.name,path:path.join(p,e.name),directory:e.isDirectory()})).slice(0,1000)}catch{}res.json({path:p,parent:path.dirname(p),entries});});
app.get('/api/logs',(req,res)=>{const j=jobs.find(x=>x.id===req.query.id);res.type('text/plain').send(j?.log||'');});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
process.on('SIGTERM',()=>{ try{if(activeChild)activeChild.kill('SIGTERM')}catch{}; process.exit(0); });
process.on('SIGINT',()=>{ try{if(activeChild)activeChild.kill('SIGTERM')}catch{}; process.exit(0); });
function listen(){ if(SOCKET_PATH){try{fs.unlinkSync(SOCKET_PATH)}catch{} app.listen(SOCKET_PATH,()=>{try{fs.chmodSync(SOCKET_PATH,0o660)}catch{} console.log('Whisper NAS listening on '+SOCKET_PATH);});}else app.listen(PORT,'127.0.0.1',()=>console.log('Whisper NAS listening on '+PORT)); }
listen();
if (settings.model && fs.existsSync(path.join(MODEL_DIR, settings.model))) setImmediate(pump);
