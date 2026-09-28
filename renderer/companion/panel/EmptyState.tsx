import { resolveActiveCharacter, type PublicConfig } from '@shared/config';
import { CheckIcon, ChevronRightIcon, ImageIcon, KeyIcon, TerminalIcon } from './icons';
import type { SettingsGroup } from './SettingsDrawer';
import { characterArt } from '../../shared/ui-assets';

export function setupSteps(config: PublicConfig) {
  const active = resolveActiveCharacter(config);
  return [
    { id: 'vidu-key', title: '填 Vidu API Key', desc: `让${active.name}能开口说话（实时数字人）`, done: config.vidu.hasKey, icon: KeyIcon, group: 'avatar' as SettingsGroup, field: 'vidu.apiKey' },
    active.character
      ? { id: 'image', title: `给${active.name}一个形象`, desc: '生成绿幕立绘，或选一张绿幕背景的人物全身图', done: Boolean(active.imagePath), icon: ImageIcon, group: 'characters' as SettingsGroup, field: 'character.portrait' }
      : { id: 'image', title: '选一张参考图', desc: '绿幕背景的人物半身图效果最好', done: Boolean(config.vidu.imagePath), icon: ImageIcon, group: 'avatar' as SettingsGroup, field: 'vidu.imagePath' },
    { id: 'td-key', title: '填 TokenDance API Key', desc: '让后台 agent 能替你干活', done: config.agent.hasKey, icon: TerminalIcon, group: 'agent' as SettingsGroup, field: 'agent.apiKey' },
  ];
}

export function EmptyState({ config, onOpen }: { config: PublicConfig; onOpen(group: SettingsGroup, field: string): void }) {
  const steps = setupSteps(config);
  const name = resolveActiveCharacter(config).name;
  const hero = characterArt(config).hero; // her own Q 版 waving picture, or the bundled 小栖 one
  const left = steps.filter(s => !s.done).length;
  if (left === 0) {
    return (
      <div className="empty">
        <img className="empty-hero" src={hero} alt="" draggable={false} />
        <b>准备好了</b>
        <p>跟{name}打个招呼，或者点下面的快捷任务让她帮你做点事。</p>
      </div>
    );
  }
  return (
    <div className="empty">
      <img className="empty-hero" src={hero} alt="" draggable={false} />
      <b>三步让{name}上线</b>
      <p>还差 {left} 步。点一项直接跳到对应设置。</p>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.id}>
            <button type="button" className={`step${s.done ? ' done' : ''}`} onClick={() => onOpen(s.group, s.field)}>
              <span className="step-num">{s.done ? <CheckIcon width={12} height={12} strokeWidth={3} /> : i + 1}</span>
              <s.icon width={15} height={15} className="step-icon" />
              <span className="step-text"><span className="step-title">{s.title}</span><span className="step-desc">{s.desc}</span></span>
              <ChevronRightIcon width={14} height={14} className="step-chev" />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
