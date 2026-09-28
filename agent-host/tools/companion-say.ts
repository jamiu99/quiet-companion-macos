import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

export function createCompanionSayTool(relay: (text: string, mood?: string, action?: string) => void) {
  return defineTool({
    name: 'companion_say',
    label: '让数字人说话',
    description: '让桌面上的数字人（小栖）用她自己的口吻把这句话转述给用户。用于汇报任务开始、关键进展和完成结果。一次不超过 60 字，口语化。',
    promptSnippet: 'companion_say: 让数字人开口向用户汇报进展/结果',
    parameters: Type.Object({
      text: Type.String({ description: '要转述给用户的内容，口语化，≤60 字' }),
      mood: Type.Optional(Type.String({ description: '可选情绪提示：happy / calm / sorry / excited' })),
      action: Type.Optional(Type.String({ description: '可选动作提示，例如 挥手 / 点头 / 比个OK' })),
    }),
    executionMode: 'parallel',
    async execute(_id, params) {
      relay(params.text, params.mood, params.action);
      return { content: [{ type: 'text', text: '已交给小栖转述。继续你的任务。' }], details: {} };
    },
  });
}
