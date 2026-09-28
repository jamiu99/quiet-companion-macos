import { useEffect, useState } from 'react';
import { TOKENDANCE_AUTH_DOCS, type TokenDanceAuthStatus } from '@shared/auth';

/** Only polls a public status. No OAuth URL, verifier, code or newly issued key enters this component. */
export function TokenDanceAccess({ hasKey }: { hasKey: boolean }) {
  const [status, setStatus] = useState<TokenDanceAuthStatus>({ phase: 'idle', message: '' });
  const [pending, setPending] = useState(false);
  const supported = Boolean(window.companion.beginTokenDanceAuth && window.companion.getTokenDanceAuth);
  useEffect(() => {
    if (!supported) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await window.companion.getTokenDanceAuth!(); if (!disposed) setStatus(next); }
      catch { /* Keep the last public state; never echo a raw transport error. */ }
      finally { if (!disposed) timer = setTimeout(poll, 750); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [supported]);
  const busy = pending || ['starting', 'waiting', 'exchanging'].includes(status.phase);
  const start = async () => {
    if (busy || !supported) return;
    setPending(true);
    try { setStatus(await window.companion.beginTokenDanceAuth!()); }
    catch { setStatus({ phase: 'error', message: '无法开始授权，请重试或手动填写 Key。' }); }
    finally { setPending(false); }
  };
  const cancel = async () => {
    try { const next = await window.companion.cancelTokenDanceAuth?.(); if (next) setStatus(next); }
    catch { setStatus({ phase: 'error', message: '取消结果未确认，请稍后查看；授权窗口最长保留 10 分钟。' }); }
  };
  return <section className="api-help" aria-label="TokenDance 授权说明" data-field="agent.apiKey">
    <b>推荐：浏览器安全授权</b>
    <ol>
      <li>打开 TokenDance 官网，在浏览器登录。</li>
      <li>确认新 Key 的名称、额度、有效期与 RPM。</li>
      <li>确认后自动保存，返回栖伴查看结果，无需复制 Key。</li>
    </ol>
    <div className="btn-row">
      <button type="button" className="btn" disabled={!supported || busy} onClick={() => void start()}>{busy ? '授权进行中…' : hasKey ? '重新授权新 Key' : '使用 TokenDance 授权'}</button>
      {busy && <button type="button" className="btn" disabled={pending} onClick={() => void cancel()}>取消授权</button>}
    </div>
    {status.message && <p role="status" className="api-status" data-phase={status.phase}>{status.message}</p>}
    {!supported && <p className="field-hint">此预览 / 旧版不支持自动授权，请使用下方手动填写。</p>}
    <p className="field-hint">采用 S256 PKCE；完整新 Key 不回传设置页面。完成后使用官方网关，替换本机 Agent Key，运行中的 Agent 会重启；不会删除旧 Key，也不会自动连接 Vidu。</p>
    <p className="field-hint">本机配置为 0600 权限，尚未使用 Keychain 加密。关闭设置不会取消授权；取消本地流程不能撤销网页已创建的 Key。</p>
    <div className="btn-row">
      <button type="button" className="link" onClick={() => void window.companion.openExternal(TOKENDANCE_AUTH_DOCS)}>授权说明</button>
      <button type="button" className="link" onClick={() => void window.companion.openExternal('https://tokendance.space')}>官网 / Key 管理与充值</button>
    </div>
    <p className="field-hint">余额不足：充值，不必换 Key。Key 失效 / 总额度用尽：重新授权。每日 / 每周 / 每月额度用尽：等待刷新或重新授权。</p>
  </section>;
}
