// The chat panel embedded next to the avatar: status strip / transcript / quick tasks + composer, with the settings
// drawer sliding in from the right over the panel. `mode` 'collapsed' = one-line input bar (two status dots + input).
// Placement (left/bottom) is computed by Stage; the panel is 360 px wide and grows with content up to 440 px.
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { resolveActiveCharacter, type PublicConfig } from '@shared/config';
import type { AppState } from '@shared/events';
import { StatusBar, StatusDot, agentTone, avatarTone } from './StatusBar';
import { Transcript } from './Transcript';
import { Composer, QuickChips } from './Composer';
import { SettingsDrawer, type SettingsGroup, type SettingsTarget } from './SettingsDrawer';
import { EmptyState } from './EmptyState';
import { ChevronUpIcon } from './icons';
import { characterArt } from '../../shared/ui-assets';
import './panel.css';

export type PanelMode = 'full' | 'collapsed';

export function Panel({ state, config, setConfig, style, side, mode, onMode, settings, onSettings, target, onTarget, openSettings, onHide, resizeHandle }: {
  state: AppState; config: PublicConfig; setConfig(patch: Record<string, unknown>): Promise<void>;
  style: CSSProperties; side: 'left' | 'right';
  mode: PanelMode; onMode(m: PanelMode): void;
  settings: boolean; onSettings(open: boolean): void;
  target: SettingsTarget; onTarget(t: SettingsTarget): void;
  openSettings(group?: SettingsGroup, field?: string): void;
  onHide(): void;
  /** Drag grip rendered at the panel's outer-top corner (Stage owns the resize logic). */
  resizeHandle?: ReactNode;
}) {
  const { avatar, agent, transcript } = state;
  // Hotkey summons the panel: main focuses the window, we put the caret in the input (unless something else has it).
  useEffect(() => {
    const focusInput = () => {
      if (document.activeElement && document.activeElement !== document.body) return;
      document.querySelector<HTMLTextAreaElement>('.panel .composer textarea')?.focus();
    };
    window.addEventListener('focus', focusInput);
    return () => window.removeEventListener('focus', focusInput);
  }, []);
  const running = agent.status === 'running';
  const connectingAvatar = ['creating', 'warming', 'connecting'].includes(avatar.phase);
  const name = resolveActiveCharacter(config).name;
  const art = characterArt(config);
  if (mode === 'collapsed') {
    return (
      <div className={`panel collapsed interactive side-${side}`} style={style}>
        <button type="button" className="panel-dots" aria-label="展开" title="展开面板" onClick={() => onMode('full')}>
          <StatusDot tone={avatarTone(avatar.phase)} breathing={!['idle', 'live', 'error'].includes(avatar.phase)} />
          <StatusDot tone={agentTone(agent.status)} breathing={running || agent.status === 'starting'} />
        </button>
        <Composer compact placeholder={connectingAvatar ? '数字人正在创建中，先说的话会在接通后转达' : running ? '继续说，会插队给 agent' : `跟${name}说点什么…`} />
        <button type="button" className="icon-btn" aria-label="展开" title="展开面板" onClick={() => onMode('full')}><ChevronUpIcon /></button>
      </div>
    );
  }
  return (
    <div className={`panel interactive side-${side}${settings ? ' with-settings' : ''}`} style={style}>
      {resizeHandle}
      <StatusBar avatar={avatar} agent={agent} name={name} bust={art.ownBust ? art.bust : undefined} onSettings={() => (settings ? onSettings(false) : openSettings())} onCollapse={() => onMode('collapsed')} onHide={onHide} onClear={() => void window.companion.clearSession?.()} />
      <main className="content">
        <Transcript items={transcript} showDetails={Boolean(config.ui.showAgentDetails)} empty={<EmptyState config={config} onOpen={openSettings} />} />
        <footer className="foot">
          <QuickChips config={config} avatar={avatar} agent={agent} />
          <Composer placeholder={connectingAvatar ? '数字人正在创建中，先说的话会在接通后转达' : running ? '可以继续说，会插队给 agent' : `跟${name}说点什么，或者让她帮你做点事…`} />
        </footer>
        <SettingsDrawer open={settings} target={target} onGroup={g => onTarget({ ...target, group: g })} config={config} setConfig={setConfig} onClose={() => onSettings(false)} jobs={state.characterJobs} viduLog={state.viduLog} />
      </main>
    </div>
  );
}
