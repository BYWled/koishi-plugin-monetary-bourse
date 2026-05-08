// K线模型分类
export type PatternCategory = "bullish" | "bearish" | "neutral";

// K线模型定义接口
interface KLinePatternType {
  fn: (p: number) => number; // 价格偏移函数，p为进度(0-1)，返回偏移系数
  category: PatternCategory; // 模型分类
  name: string; // 中文名称
  description: string; // 描述
  endBias: number; // 结束时的偏置倾向（正=涨，负=跌）
}

// K线形态模型库（25种模型，分为看涨/看跌/中性三类）
export const kLinePatterns: Record<string, KLinePatternType> = {
  // ==================== 看涨模型 (8种) ====================
  bullish_steady: {
    fn: (p: number) =>
      Math.sin((p * Math.PI) / 2) * 0.8 + Math.sin(p * Math.PI * 3) * 0.08,
    category: "bullish",
    name: "单边上涨",
    description: "持续稳健上涨",
    endBias: 0.8,
  },
  bullish_v_reversal: {
    fn: (p: number) => {
      if (p < 0.25) return -Math.sin(((p / 0.25) * Math.PI) / 2) * 0.6;
      return -0.6 + ((p - 0.25) / 0.75) * 1.4;
    },
    category: "bullish",
    name: "V型反转",
    description: "快速下跌后强势反弹",
    endBias: 0.8,
  },
  bullish_stair: {
    fn: (p: number) => {
      const step = Math.floor(p * 4);
      const inStep = (p * 4) % 1;
      const base = step * 0.22;
      const stepMove =
        inStep < 0.7
          ? Math.sin(((inStep / 0.7) * Math.PI) / 2) * 0.25
          : 0.25 - ((inStep - 0.7) / 0.3) * 0.08;
      return base + stepMove;
    },
    category: "bullish",
    name: "阶梯上涨",
    description: "分阶段上涨，每段有小回调",
    endBias: 0.72,
  },
  bullish_late_rally: {
    fn: (p: number) => {
      if (p < 0.7) return Math.sin((p / 0.7) * Math.PI * 2) * 0.15;
      return ((p - 0.7) / 0.3) * 0.9;
    },
    category: "bullish",
    name: "尾盘拉升",
    description: "前期平稳，尾盘急拉",
    endBias: 0.9,
  },
  bullish_double_bottom: {
    fn: (p: number) => {
      if (p < 0.25) return -Math.sin(((p / 0.25) * Math.PI) / 2) * 0.5;
      if (p < 0.5)
        return -0.5 + Math.sin((((p - 0.25) / 0.25) * Math.PI) / 2) * 0.35;
      if (p < 0.75)
        return -0.15 - Math.sin((((p - 0.5) / 0.25) * Math.PI) / 2) * 0.35;
      return -0.5 + ((p - 0.75) / 0.25) * 1.1;
    },
    category: "bullish",
    name: "W底突破",
    description: "双底确认后持续上涨",
    endBias: 0.6,
  },
  bullish_gap_up: {
    fn: (p: number) => {
      if (p < 0.1) return (p / 0.1) * 0.4;
      return (
        0.4 +
        Math.sin((((p - 0.1) / 0.9) * Math.PI) / 2) * 0.4 +
        Math.sin(p * Math.PI * 4) * 0.05
      );
    },
    category: "bullish",
    name: "跳空高开",
    description: "跳空高开后震荡上行",
    endBias: 0.8,
  },
  bullish_three_soldiers: {
    fn: (p: number) => {
      const phase = p * 3;
      const segment = Math.floor(phase);
      const inSegment = phase % 1;
      if (segment === 0) return Math.sin((inSegment * Math.PI) / 2) * 0.3;
      if (segment === 1)
        return 0.3 + Math.sin((inSegment * Math.PI) / 2) * 0.28;
      return 0.58 + Math.sin((inSegment * Math.PI) / 2) * 0.25;
    },
    category: "bullish",
    name: "红三兵",
    description: "连续三段上涨，渐次抬升",
    endBias: 0.75,
  },
  bullish_morning_dip: {
    fn: (p: number) => {
      if (p < 0.2) return -Math.sin(((p / 0.2) * Math.PI) / 2) * 0.3;
      return -0.3 + ((p - 0.2) / 0.8) * 1.1;
    },
    category: "bullish",
    name: "早盘低开高走",
    description: "早盘低开后持续上涨",
    endBias: 0.8,
  },

  // ==================== 看跌模型 (8种) ====================
  bearish_steady: {
    fn: (p: number) =>
      -Math.sin((p * Math.PI) / 2) * 0.8 + Math.sin(p * Math.PI * 3) * 0.08,
    category: "bearish",
    name: "单边下跌",
    description: "持续稳健下跌",
    endBias: -0.8,
  },
  bearish_inverted_v: {
    fn: (p: number) => {
      if (p < 0.35) return Math.sin(((p / 0.35) * Math.PI) / 2) * 0.5;
      return 0.5 - ((p - 0.35) / 0.65) * 1.3;
    },
    category: "bearish",
    name: "冲高回落",
    description: "快速上涨后深度回落",
    endBias: -0.8,
  },
  bearish_stair: {
    fn: (p: number) => {
      const step = Math.floor(p * 4);
      const inStep = (p * 4) % 1;
      const base = -step * 0.22;
      const stepMove =
        inStep < 0.7
          ? -Math.sin(((inStep / 0.7) * Math.PI) / 2) * 0.25
          : -0.25 + ((inStep - 0.7) / 0.3) * 0.08;
      return base + stepMove;
    },
    category: "bearish",
    name: "阶梯下跌",
    description: "分阶段下跌，每段有小反弹",
    endBias: -0.72,
  },
  bearish_late_dive: {
    fn: (p: number) => {
      if (p < 0.7) return Math.sin(((p / 0.7) * Math.PI) / 2) * 0.25;
      return 0.25 - ((p - 0.7) / 0.3) * 1.15;
    },
    category: "bearish",
    name: "尾盘跳水",
    description: "前期平稳，尾盘急跌",
    endBias: -0.9,
  },
  bearish_double_top: {
    fn: (p: number) => {
      if (p < 0.25) return Math.sin(((p / 0.25) * Math.PI) / 2) * 0.5;
      if (p < 0.5)
        return 0.5 - Math.sin((((p - 0.25) / 0.25) * Math.PI) / 2) * 0.35;
      if (p < 0.75)
        return 0.15 + Math.sin((((p - 0.5) / 0.25) * Math.PI) / 2) * 0.35;
      return 0.5 - ((p - 0.75) / 0.25) * 1.1;
    },
    category: "bearish",
    name: "M顶回落",
    description: "双顶确认后持续下跌",
    endBias: -0.6,
  },
  bearish_gap_down: {
    fn: (p: number) => {
      if (p < 0.1) return (-p / 0.1) * 0.4;
      return (
        -0.4 -
        Math.sin((((p - 0.1) / 0.9) * Math.PI) / 2) * 0.4 +
        Math.sin(p * Math.PI * 4) * 0.05
      );
    },
    category: "bearish",
    name: "跳空低开",
    description: "跳空低开后震荡下行",
    endBias: -0.8,
  },
  bearish_three_crows: {
    fn: (p: number) => {
      const phase = p * 3;
      const segment = Math.floor(phase);
      const inSegment = phase % 1;
      if (segment === 0) return -Math.sin((inSegment * Math.PI) / 2) * 0.3;
      if (segment === 1)
        return -0.3 - Math.sin((inSegment * Math.PI) / 2) * 0.28;
      return -0.58 - Math.sin((inSegment * Math.PI) / 2) * 0.25;
    },
    category: "bearish",
    name: "黑三鸦",
    description: "连续三段下跌，渐次走低",
    endBias: -0.75,
  },
  bearish_morning_bounce: {
    fn: (p: number) => {
      if (p < 0.2) return Math.sin(((p / 0.2) * Math.PI) / 2) * 0.3;
      return 0.3 - ((p - 0.2) / 0.8) * 1.1;
    },
    category: "bearish",
    name: "早盘高开低走",
    description: "早盘高开后持续下跌",
    endBias: -0.8,
  },

  // ==================== 中性模型 (9种) ====================
  neutral_consolidation: {
    fn: (p: number) =>
      Math.sin(p * Math.PI * 4) * 0.25 + Math.sin(p * Math.PI * 7) * 0.1,
    category: "neutral",
    name: "横盘整理",
    description: "窄幅震荡，无明显方向",
    endBias: 0,
  },
  neutral_wide_range: {
    fn: (p: number) =>
      Math.sin(p * Math.PI * 2) * 0.5 + Math.sin(p * Math.PI * 5) * 0.15,
    category: "neutral",
    name: "宽幅震荡",
    description: "大幅波动但最终回归起点",
    endBias: 0,
  },
  neutral_converging: {
    fn: (p: number) => Math.sin(p * Math.PI * 6) * 0.4 * (1 - p),
    category: "neutral",
    name: "收敛三角",
    description: "波动逐渐收窄",
    endBias: 0,
  },
  neutral_diverging: {
    fn: (p: number) => Math.sin(p * Math.PI * 6) * 0.15 * (1 + p * 2),
    category: "neutral",
    name: "发散三角",
    description: "波动逐渐放大",
    endBias: 0,
  },
  neutral_box: {
    fn: (p: number) => {
      const cycles = 3;
      const phase = (p * cycles) % 1;
      if (phase < 0.25) return (phase / 0.25) * 0.35;
      if (phase < 0.75) return 0.35 - ((phase - 0.25) / 0.5) * 0.7;
      return -0.35 + ((phase - 0.75) / 0.25) * 0.35;
    },
    category: "neutral",
    name: "箱体震荡",
    description: "在固定区间内来回波动",
    endBias: 0,
  },
  neutral_up_down: {
    fn: (p: number) => {
      if (p < 0.5) return Math.sin(((p / 0.5) * Math.PI) / 2) * 0.5;
      return 0.5 - ((p - 0.5) / 0.5) * 0.5;
    },
    category: "neutral",
    name: "先涨后跌",
    description: "上涨后回落至起点",
    endBias: 0,
  },
  neutral_down_up: {
    fn: (p: number) => {
      if (p < 0.5) return -Math.sin(((p / 0.5) * Math.PI) / 2) * 0.5;
      return -0.5 + ((p - 0.5) / 0.5) * 0.5;
    },
    category: "neutral",
    name: "先跌后涨",
    description: "下跌后反弹至起点",
    endBias: 0,
  },
  neutral_slight_up: {
    fn: (p: number) => p * 0.15 + Math.sin(p * Math.PI * 5) * 0.12,
    category: "neutral",
    name: "微涨震荡",
    description: "小幅上涨伴随震荡",
    endBias: 0.15,
  },
  neutral_slight_down: {
    fn: (p: number) => -p * 0.15 + Math.sin(p * Math.PI * 5) * 0.12,
    category: "neutral",
    name: "微跌震荡",
    description: "小幅下跌伴随震荡",
    endBias: -0.15,
  },
};
