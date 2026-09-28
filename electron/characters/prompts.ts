// Prompt builders for the two TokenDance generation calls. Pure functions (unit-tested).
import type { Character, CharacterStyle } from '@shared/config';

/** Style clause appended to the portrait prompt. `follow-reference` reads differently with / without a reference image. */
export const STYLE_PROMPTS: Record<CharacterStyle, string> = {
  anime: '二维动漫风格，流畅线稿与赛璐璐上色，色彩明亮干净',
  flat: '平面插画风格，简洁轮廓、平涂色块和克制的明暗',
  'clean-line': '二维清线漫画风格，清晰描边、简洁色块与赛璐璐阴影',
  realistic: '自然写实数字人风格，真实皮肤与衣物质感，不过度磨皮',
  '3d': '精致自然的 3D 角色渲染风格，柔和材质，避免塑料感',
  'follow-reference': '严格沿用参考图的画风、线条、上色方式、明暗层次和比例',
};

/** Portrait prompt (verified skeleton from tasks/07-characters.md: clean #00FF00 background, 9:16, full body). */
export function buildPortraitPrompt(c: Pick<Character, 'appearance' | 'style'>, hasReference: boolean): string {
  const appearance = c.appearance.trim().replace(/[。.]+$/, '');
  const style = c.style === 'follow-reference' && !hasReference ? '画风按外观描述自然选择' : STYLE_PROMPTS[c.style] ?? STYLE_PROMPTS.anime;
  const ref = hasReference ? '参考图就是这个角色：保留参考图的人物特征、发型、服装和身体比例，只按下面的要求重新构图。' : '';
  return `${ref}一位${appearance}，全身竖构图，正面站姿，双手自然放在身前，微笑看向镜头。${style}。纯色正绿色（#00FF00）背景，绿幕抠像专用：背景完全平铺无渐变、无阴影、无地面、无任何道具。人物边缘清晰，头发不要有透明飘散细丝，衣服不要有任何绿色。柔和均匀正面光，高清，9:16 竖版。服装颜色明确、单一角色。不要文字、水印、边框或其他人物。`;
}

/** Idle-loop prompt: the 8 s version chosen in docs/ASSETS.md, with the subject made generic. */
export function buildIdlePrompt(c: Pick<Character, 'name'> & Partial<Pick<Character, 'appearance'>>): string {
  const look = c.appearance?.trim().replace(/[。.]+$/, '');
  // Consistency lock: an earlier run repainted a white cardigan in another colour. Name the clothes explicitly and forbid
  // any colour / garment / hairstyle change relative to the first frame (which is the portrait itself).
  const lock = `${look ? `人物外观：${look}。` : ''}服装的款式、颜色、图案，发型、发色，配饰和鞋子都必须与第一帧完全一致，逐帧保持不变，不要换色、不要换装、不要增减任何物品。`;
  return `画面中的人物（${c.name.trim() || '角色'}）保持原样安静站立，人物五官、发型、服装和纯绿色背景完全不变。${lock}镜头完全固定，不推不拉不摇。动作极其轻微、缓慢：胸口随呼吸微微起伏，中途自然地眨眼两次，头部非常缓慢地向一侧微微偏一点再回正，微笑略微加深又恢复，交握的双手手指轻轻动一下。不要走动，不要转身，不要挥手，不要大幅动作，不要出现新的物体，背景始终是均匀的纯绿色，没有阴影变化，没有文字，没有字幕，没有镜头运动。结尾回到与开头完全相同的姿势，适合无缝循环播放。`;
}

/** Q 版 art (task 09): same character as the portrait (passed as the image reference), chibi proportions, flat rounded
 *  illustration with uniform dark-grey outlines on pure #00FF00 so the main process can key it out (see art.ts). */
export type ArtKind = 'bust' | 'hero';
export const ART_STYLE = '圆润扁平插画风格，所有轮廓是粗细完全一致的深灰色（#4A4A55）圆润描边，色彩明亮干净，不要投影，不要纹理，不要文字和字母。';
export const ART_GREEN = '纯色正绿色（#00FF00）背景，完全平铺无渐变无阴影无纹理无地面，主体不含任何绿色，也不要与背景相近的颜色。单一主体居中，四周留白充足，人物边缘清晰，不要被裁切。';
export function buildArtPrompt(kind: ArtKind, c: Pick<Character, 'appearance'> & Partial<Pick<Character, 'name'>>): string {
  const look = c.appearance.trim().replace(/[。.]+$/, '');
  const who = `参考图就是这个角色，画同一角色的 Q 版（chibi）形象：大头、圆脸、大眼睛，保持参考图的发型、发色、五官特征、服装款式与配色完全一致${look ? `（${look}）` : ''}。`;
  const pose = kind === 'bust'
    ? '胸像（头和肩膀到胸口），正面略侧一点，微笑看向观众，表情温和可爱。'
    : '全身像，站姿，一只手举起挥手打招呼，表情开心，头旁飘着两颗淡粉色四角小闪光。';
  return `${who}${pose}${ART_STYLE}${ART_GREEN}`;
}
