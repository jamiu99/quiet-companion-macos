import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url), options = JSON.parse(process.argv[2]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The production main exports its orchestrator only to this trusted main-process harness, not to the renderer.
const { orchestrator, redactSecrets } = require(join(options.root, 'dist/electron/main.cjs'));
let done = false, connectedAt = 0, sampleCount = 0, sampleBusy = false, timer, durationTimer;
const report = { secondsRequested: options.seconds, phases: [], prompts: [], samples: 0, reason: '', terminalPhase: '', liveSeconds: 0, audioSpeakingEdges: 0, validSamples: 0, sampleFailures: 0 };
const finish = async reason => {
  if (done) return; done = true; clearInterval(timer); clearTimeout(durationTimer); report.reason = reason;
  report.liveSeconds = connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : 0;
  orchestrator.disconnectAvatar();
  // Creation may still be in flight: wait for its bounded result so production can hang up a returned live id.
  // After stop, allow >5s for the runtime's forced socket termination; the former 4s wait lost close evidence.
  const deadline = Date.now() + 110000;
  let inactiveSince;
  while (Date.now() < deadline) {
    if (orchestrator.vidu.isActive) inactiveSince = undefined;
    else inactiveSince ??= Date.now();
    if (inactiveSince && Date.now() - inactiveSince >= 2500 && (report.controlClosed || Date.now() - inactiveSince >= 8000)) break;
    await sleep(100);
  }
  report.terminalPhase = orchestrator.state.avatar.phase; report.lastMessage = redactSecrets(orchestrator.state.avatar.message ?? ''); report.samples = sampleCount;
  report.localSessionActive = orchestrator.vidu.isActive;
  report.hangupSent = (orchestrator.state.viduLog ?? []).some(l => l.dir === 'out' && l.tag === 'hangup' && l.text === 'user_end');
  const logFile = join(process.env.COMPANION_USER_DATA, 'logs/main.log');
  if (existsSync(logFile)) {
    const lines = readFileSync(logFile, 'utf8').split('\n').filter(l => /HEALTH |GREENKEY|FRAMING|FIRST_FRAME|RESET |STALL |ws close|hangup|avatar speaking=/.test(l));
    // Diagnostics only. Never retain config, .env, models.json, RTC credentials or complete chat logs.
    writeFileSync(join(options.out, 'media.log'), lines.join('\n'), { mode: 0o600 });
    report.audioSpeakingEdges = lines.filter(l => /avatar speaking=true/.test(l)).length;
    report.controlClosed = Boolean(report.controlClosed || lines.some(l => /ws close code=/.test(l)));
  }
  writeFileSync(join(options.out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`SOAK DONE reason=${reason} liveSeconds=${report.liveSeconds} samples=${sampleCount} terminal=${report.terminalPhase} controlClosed=${report.controlClosed}`);
  const exitCode = reason === 'duration' && report.controlClosed && report.terminalPhase === 'idle' && report.validSamples > 0 && report.sampleFailures === 0 ? 0 : 1;
  app.once('will-quit', () => app.exit(exitCode));
  app.quit();
};
process.on('SIGINT', () => void finish('signal')); process.on('SIGTERM', () => void finish('signal'));
setTimeout(() => void finish('hard-cap'), options.seconds * 1000 + 200000);
orchestrator.on('log', line => { if (/ws close code=/.test(line)) report.controlClosed = true; });
orchestrator.on('state', s => {
  if (report.phases.at(-1)?.phase !== s.avatar.phase) { report.phases.push({ at: Date.now(), phase: s.avatar.phase }); console.log(`SOAK phase=${s.avatar.phase}`); }
  if (!done && !connectedAt && s.avatar.phase === 'live') { connectedAt = Date.now(); durationTimer = setTimeout(() => void finish('duration'), options.seconds * 1000); }
  if (!done && (s.avatar.phase === 'error' || connectedAt && s.avatar.phase === 'idle')) void finish('session-ended');
});
app.whenReady().then(async () => {
  if (done) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('No production window');
  win.webContents.setAudioMuted(true); // Receive and measure remote audio; do not play minutes of test speech through speakers.
  for (let i = 0; i < 150; i++) {
    if (done) return;
    const ready = await win.webContents.executeJavaScript('Boolean(window.companion && document.querySelector(".stage-body > video"))').catch(() => false);
    if (ready) break;
    await sleep(100);
    if (i === 149) throw new Error('Renderer startup timeout');
  }
  if (done) return;
  await win.webContents.executeJavaScript(readFileSync(join(options.out, 'sampler.js'), 'utf8'));
  if (done) return;
  orchestrator.setBarVisible(false);
  const schedule = [
    [30, '伸个懒腰，朝我挥挥手，然后保持原地站立。'],
    [90, '转一圈，再比个心，最后回到原来的站姿。'],
    [150, '我们安静待一会儿。'],
    [240, '轻轻点头，比个心，然后恢复原来的站姿。'],
    [330, '继续保持原来的构图，聊一句今天的心情。'],
    [420, '谢谢，安静站立就好。'],
  ];
  timer = setInterval(async () => {
    if (done || !connectedAt) return;
    const elapsed = (Date.now() - connectedAt) / 1000;
    if (elapsed >= options.seconds) { void finish('duration'); return; }
    while (schedule.length && elapsed >= schedule[0][0]) {
      const [at, text] = schedule.shift();
      if (orchestrator.vidu.isLive) { orchestrator.vidu.sendText(text); report.prompts.push({ at, text }); console.log(`SOAK prompt at=${at}s`); }
    }
    if (sampleBusy) return; sampleBusy = true;
    try {
      const sample = await win.webContents.executeJavaScript('LiveSoak.sample()');
      if (done) return;
      if (!sample.skipped && !sample.errors?.length) report.validSamples++;
      if (sample.errors?.length) report.sampleFailures++;
      const { images, ...metrics } = sample;
      const name = `frame-${String(sampleCount++).padStart(4, '0')}`;
      appendFileSync(join(options.out, 'frames.jsonl'), JSON.stringify({ name, elapsed, ...metrics }) + '\n', { mode: 0o600 });
      for (const [kind, png] of Object.entries(images ?? {})) writeFileSync(join(options.out, `${name}-${kind}.png`), Buffer.from(png.split(',')[1], 'base64'), { mode: 0o600 });
      if (sampleCount % 10 === 0) console.log(`SOAK t=${elapsed.toFixed(0)}s fg=${sample.geometry?.area.toFixed(3)} restored=${sample.restoredFraction?.toFixed(3)} fallback=${sample.fallback}`);
    } catch (e) { if (!done) report.sampleFailures++; console.error(`SOAK sample failed: ${redactSecrets(String(e.message)).slice(0, 300)}`); }
    finally { sampleBusy = false; }
  }, options.sampleMs);
  await orchestrator.connectAvatar();
}).catch(e => { console.error(`SOAK fatal: ${redactSecrets(String(e.message)).slice(0, 300)}`); void finish('harness-error'); });
