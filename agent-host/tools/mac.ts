// Small, fast, predictable macOS tools for live-demo tasks. bash remains available for everything else.
// Every tool: 30 s timeout, text output truncated to 4 KB.
import { Type } from 'typebox';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { defineTool } from '@earendil-works/pi-coding-agent';

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 4 * 1024;

const runFile = promisify(execFile);
const run = (cmd: string, args: string[], signal?: AbortSignal) => runFile(cmd, args, { timeout: TIMEOUT_MS, signal, maxBuffer: 4 * 1024 * 1024 });

/** Truncate tool output to MAX_OUTPUT bytes-ish (chars) with a marker. */
export function truncate(s: string, max = MAX_OUTPUT): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[已截断，共 ${s.length} 字]`;
}
const text = (t: string) => ({ content: [{ type: 'text' as const, text: truncate(t) }], details: {} });
const fail = (prefix: string, e: unknown) => {
  const err = e as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
  const why = err?.killed || err?.code === 'ABORT_ERR' ? `超时（${TIMEOUT_MS / 1000}s）或被中止` : String(err?.stderr || err?.message || err).trim();
  return text(`${prefix}：${why.slice(0, 500)}`);
};

export const macOpenTool = defineTool({
  name: 'mac_open',
  label: '打开应用/文件/网址',
  description: '在 macOS 上打开应用、文件或网址（等价于 open 命令）。app 填应用名如 "Notes"、"Safari"、"Finder"；target 填文件路径或 URL。',
  promptSnippet: 'mac_open: 打开应用、文件或网址',
  parameters: Type.Object({
    app: Type.Optional(Type.String({ description: '应用名称，如 Notes / Safari / Music / Finder' })),
    target: Type.Optional(Type.String({ description: '文件路径或 http(s) URL' })),
  }),
  async execute(_id, { app, target }, signal) {
    const args: string[] = [];
    if (app) args.push('-a', app);
    if (target) args.push(target.startsWith('~/') || target === '~' ? join(homedir(), target.slice(1)) : target);
    if (!args.length) return text('需要 app 或 target 至少一个');
    try { await run('open', args, signal); return text(`已打开 ${[app, target].filter(Boolean).join(' ')}`); }
    catch (e) { return fail('打开失败', e); }
  },
});

export const appleScriptTool = defineTool({
  name: 'applescript',
  label: '运行 AppleScript',
  description: '运行一段 AppleScript（osascript）来控制 macOS 应用：新建备忘录、控制音乐、读取窗口标题、发送通知等。返回脚本输出。',
  promptSnippet: 'applescript: 用 AppleScript 操作 macOS 应用',
  parameters: Type.Object({ script: Type.String({ description: 'AppleScript 源码' }) }),
  async execute(_id, { script }, signal) {
    try {
      const { stdout, stderr } = await run('osascript', ['-e', script], signal);
      return text((stdout + (stderr ? `\n[stderr] ${stderr}` : '')).trim() || '（无输出）');
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { killed?: boolean };
      const app = /tell application "([^"]+)"/.exec(script)?.[1];
      // A hang until timeout almost always means macOS is waiting for the user to allow Automation for this app.
      if (err?.killed && app) return text(`AppleScript 超时（${TIMEOUT_MS / 1000}s）：很可能系统还没允许本应用控制「${app}」（系统设置 → 隐私与安全性 → 自动化）。不要重试同样的脚本，改用不依赖 AppleScript 的办法完成，并提醒用户授权。`);
      return fail('AppleScript 失败', e);
    }
  },
});

export const notifyTool = defineTool({
  name: 'mac_notify',
  label: '系统通知',
  description: '弹出一条 macOS 系统通知。',
  promptSnippet: 'mac_notify: 弹出系统通知',
  parameters: Type.Object({ title: Type.String(), body: Type.String() }),
  async execute(_id, { title, body }, signal) {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try { await run('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], signal); return text('已通知'); }
    catch (e) { return fail('通知失败', e); }
  },
});

export const clipboardTool = defineTool({
  name: 'mac_clipboard',
  label: '剪贴板',
  description: '读取或写入 macOS 剪贴板文本。action=read 返回当前剪贴板内容（pbpaste）；action=write 把 text 写入剪贴板（pbcopy）。',
  promptSnippet: 'mac_clipboard: 读/写剪贴板文本',
  parameters: Type.Object({
    action: Type.Union([Type.Literal('read'), Type.Literal('write')], { description: 'read 或 write' }),
    text: Type.Optional(Type.String({ description: 'write 时要写入的文本' })),
  }),
  async execute(_id, { action, text: value }, signal) {
    if (action === 'read') {
      try { const { stdout } = await run('pbpaste', [], signal); return text(stdout.length ? stdout : '（剪贴板为空或不是文本）'); }
      catch (e) { return fail('读取剪贴板失败', e); }
    }
    if (value === undefined) return text('write 需要 text');
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn('pbcopy', [], { signal, timeout: TIMEOUT_MS });
        p.on('error', reject);
        p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`pbcopy 退出码 ${code}`))));
        p.stdin.end(value);
      });
      return text(`已写入剪贴板（${value.length} 字）`);
    } catch (e) { return fail('写入剪贴板失败', e); }
  },
});

export const screenshotTool = defineTool({
  name: 'mac_screenshot',
  label: '截屏',
  description: '静默截取整个屏幕（screencapture -x），保存为 PNG 到工作目录，返回文件路径。如果当前模型支持看图，截图会一并返回给你，可以直接描述屏幕内容。',
  promptSnippet: 'mac_screenshot: 截取屏幕保存到工作目录（支持看图的模型会直接收到图片）',
  parameters: Type.Object({
    filename: Type.Optional(Type.String({ description: '文件名（不含目录），默认 screenshot-时间戳.png' })),
  }),
  async execute(_id, { filename }, signal, _onUpdate, ctx) {
    const name = (filename?.trim() || `screenshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`).replace(/[\/\\]/g, '_');
    const path = join(ctx.cwd, name.endsWith('.png') ? name : `${name}.png`);
    try { await run('screencapture', ['-x', path], signal); }
    catch (e) { return fail('截屏失败', e); }
    if (!existsSync(path)) return text('截屏失败：没有生成文件（可能缺少“屏幕录制”权限）');
    const size = statSync(path).size;
    const supportsImage = Array.isArray(ctx.model?.input) && ctx.model.input.includes('image');
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
      { type: 'text', text: `已截屏：${path}（${Math.round(size / 1024)} KB）${supportsImage ? '，图片见下' : ''}` },
    ];
    if (supportsImage) {
      // Downscale a JPEG copy so the payload stays small; the full-size PNG remains on disk for the user.
      const tmp = join(tmpdir(), `qc-shot-${Date.now()}.jpg`);
      try {
        await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', '1280', path, '--out', tmp], signal);
        content.push({ type: 'image', data: readFileSync(tmp).toString('base64'), mimeType: 'image/jpeg' });
      } catch { /* image attachment is best-effort */ }
      finally { try { unlinkSync(tmp); } catch { /* ignore */ } }
    }
    return { content, details: { path, size } };
  },
});

export const macTools = [macOpenTool, appleScriptTool, notifyTool, clipboardTool, screenshotTool];
