import params from './params.js';

// Verbatim Appendix 4.A. Only substitute its duration placeholder once calibrated.
export const introduction = [
  '欢迎。',
  `接下来大约${params.phaseDuration === null ? '【X】' : params.phaseDuration * 4}分钟，你和对面的人各拿一部手机。`,
  '倾斜或晃动手机，它会发出声音。声音从你手里的这部手机发出。',
  '没有正确或错误的玩法，随意探索就好。',
  '体验分为几段，段与段之间会有一个提示音。',
  '准备好后，点击"开始"。之后屏幕会变黑，不需要再看屏幕。',
];
