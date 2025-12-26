import { Context, Schema, h, Time, Logger } from 'koishi'
import { resolve } from 'path'
import { promises as fs } from 'fs'
import {} from 'koishi-plugin-monetary'
import {} from 'koishi-plugin-puppeteer'

export const name = 'monetary-bourse'
// 注入依赖：monetary(可选，用于兼容), database(必须), puppeteer(必须)
// 注意：monetaryBank 是软依赖，我们在代码中动态检查
export const inject = {
  required: ['database', 'puppeteer'],
  optional: ['monetary']
}

const logger = new Logger('bourse')

// --- 数据库模型声明 ---

// 银行插件的数据库表结构（用于直接查询）
interface MonetaryBankInterest {
  id: number
  uid: number
  currency: string
  amount: number
  type: 'demand' | 'fixed'
  rate: number
  cycle: 'day' | 'week' | 'month'
  settlementDate: Date
  extendRequested: boolean
  nextRate?: number
  nextCycle?: 'day' | 'week' | 'month'
}

declare module 'koishi' {
  interface Tables {
    bourse_holding: BourseHolding
    bourse_pending: BoursePending
    bourse_history: BourseHistory
    bourse_state: BourseState
    // 银行插件的表（可选）
    monetary_bank_int: MonetaryBankInterest
  }
}

export interface BourseHolding {
  id: number
  userId: string
  stockId: string
  amount: number
  totalCost: number // 买入总成本，用于计算盈亏
}

export interface BoursePending {
  id: number
  userId: string
  uid: number // 数字类型的用户ID，用于货币操作
  stockId: string
  type: 'buy' | 'sell'
  amount: number
  price: number // 交易时的单价
  cost: number // 总成本或总收益
  startTime: Date
  endTime: Date
}

export interface BourseHistory {
  id: number
  stockId: string
  price: number
  time: Date
}

// 全局状态：用于宏观调控的持久化
export interface BourseState {
  key: string // 固定为 'macro_state'
  lastCycleStart: Date // 本周期开始时间
  startPrice: number // 本周期起始价格
  targetPrice: number // 本周期目标价格
  trendFactor: number // 每分钟的价格变化趋势量
  mode: 'auto' | 'manual' // 调控模式：自动或手动
  endTime: Date // 本周期预计结束时间
  marketOpenStatus?: 'open' | 'close' | 'auto' // 市场开关状态
}

// --- 插件配置 ---

export interface Config {
  currency: string
  stockName: string
  initialPrice: number
  maxHoldings: number
  // 交易时间设置
  openHour: number
  closeHour: number
  // 冻结机制设置
  freezeCostPerMinute: number // 每多少货币计为1分钟冻结时间
  minFreezeTime: number // 最小冻结时间（分钟）
  maxFreezeTime: number // 最大冻结时间（分钟）
  // 股市开关
  marketStatus: 'open' | 'close' | 'auto'
  // 开发者选项
  enableDebug: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    currency: Schema.string().default('信用点').description('货币单位名称'),
    stockName: Schema.string().default('Koishi股份').description('股票名称'),
    initialPrice: Schema.number().min(0.01).default(1200).description('股票初始价格'),
    maxHoldings: Schema.number().min(1).step(1).default(100000).description('单人最大持仓限制'),
  }).description('基础设置'),
  
  Schema.object({
    marketStatus: Schema.union(['open', 'close', 'auto']).default('auto').description('股市开关状态：open=强制开启，close=强制关闭，auto=按时间自动'),
  }).description('股市开关'),

  Schema.object({
    openHour: Schema.number().min(0).max(23).step(1).default(8).description('开市时间 (小时)'),
    closeHour: Schema.number().min(0).max(23).step(1).default(23).description('休市时间 (小时)'),
  }).description('交易时间'),

  Schema.object({
    freezeCostPerMinute: Schema.number().min(1).default(100).description('每多少货币计为1分钟冻结时间'),
    minFreezeTime: Schema.number().min(0).default(10).description('最小冻结时间(分钟)'),
    maxFreezeTime: Schema.number().min(0).default(1440).description('最大交易冻结时间(分钟)'),
  }).description('冻结机制'),

  Schema.object({
    enableDebug: Schema.boolean().default(false).description('启用调试模式（开启后可使用调试指令）'),
  }).description('开发者选项'),
])

// --- 核心实现 ---

export function apply(ctx: Context, config: Config) {
  // 1. 初始化数据库模型
  ctx.model.extend('bourse_holding', {
    id: 'unsigned',
    userId: 'string',
    stockId: 'string',
    amount: 'integer',
    totalCost: 'double', // 买入总成本
  }, { primary: ['userId', 'stockId'] })

  ctx.model.extend('bourse_pending', {
    id: 'unsigned',
    userId: 'string',
    uid: 'unsigned',
    stockId: 'string',
    type: 'string',
    amount: 'integer',
    price: 'double',
    cost: 'double',
    startTime: 'timestamp',
    endTime: 'timestamp',
  }, { autoInc: true })

  ctx.model.extend('bourse_history', {
    id: 'unsigned',
    stockId: 'string',
    price: 'double',
    time: 'timestamp',
  }, { autoInc: true })

  ctx.model.extend('bourse_state', {
    key: 'string',
    lastCycleStart: 'timestamp',
    startPrice: 'double',
    targetPrice: 'double',
    trendFactor: 'double',
    mode: 'string',
    endTime: 'timestamp',
    marketOpenStatus: 'string',
  }, { primary: 'key' })

  // 2. 股票引擎状态
  const stockId = 'MAIN' // 目前仅支持一支股票
  let currentPrice = Number(config.initialPrice.toFixed(2))

  // 启动时加载最近行情，若无则写入初始价格
  ctx.on('ready', async () => {
    const history = await ctx.database.get('bourse_history', { stockId }, { limit: 1, sort: { time: 'desc' } })
    if (history.length > 0) {
      currentPrice = Number(history[0].price.toFixed(2))
    } else {
      await ctx.database.create('bourse_history', { stockId, price: currentPrice, time: new Date() })
    }
  })

  // 追踪市场开市状态，用于在开市时切换K线模型
  let wasMarketOpen = false
  // 记录当日开盘价，用于日内涨跌幅限制
  let dailyOpenPrice: number | null = null
  // 随机自动宏观调控参数（频率与幅度）
  let macroWaveCount = 7
  let macroWeeklyAmplitudeRatio = 0.08
  // 随机自动宏观目标刷新时间
  let nextMacroSwitchTime: Date | null = null
  // 内部测试用：虚拟时间（存在则以此为准，不使用系统时间）
  let __testNow: Date | null = null

  // 市场定时任务（每 2 分钟运行一次）
  ctx.setInterval(async () => {
    const isOpen = await isMarketOpen()
    
    // 检测开市事件：从关闭变为开启
    if (isOpen && !wasMarketOpen) {
      // 开市了，切换K线模型
      switchKLinePattern('自动开市')
      // 记录当日开盘价（用于日内限制）
      dailyOpenPrice = currentPrice
      // 初始化随机宏观刷新时间（6-24小时）
      const hours = 6 + Math.floor(Math.random() * 19)
      nextMacroSwitchTime = new Date(Date.now() + hours * 3600 * 1000)
    }
    wasMarketOpen = isOpen
    
    if (!isOpen) return
    await updatePrice()
    await processPendingTransactions()

    // 清理一个月前的记录
    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    await ctx.database.remove('bourse_history', { time: { $lt: oneMonthAgo } })
  }, 2 * 60 * 1000)

  // 辅助：检查是否开市（简化的周末与时间校验）
  async function isMarketOpen() {
    // 优先使用配置中的开关
    if (config.marketStatus === 'open') return true
    if (config.marketStatus === 'close') return false

    // 其次检查数据库中的手动开关（命令设置的）
    const states = await ctx.database.get('bourse_state', { key: 'macro_state' })
    const state = states[0]
    if (state && state.marketOpenStatus) {
      if (state.marketOpenStatus === 'open') return true
      if (state.marketOpenStatus === 'close') return false
    }

    const now = new Date()
    const day = now.getDay()
    const hour = now.getHours()
    
    // 0 是周日, 6 是周六
    if (day === 0 || day === 6) return false
    if (hour < config.openHour || hour >= config.closeHour) return false
    return true
  }

  // --- 资金操作辅助函数 ---

  /**
   * 获取现金余额（从monetary表查询）
   * monetary 表结构：{ uid: number, currency: string, value: number }
   */
  async function getCashBalance(uid: number, currency: string): Promise<number> {
    if (!uid || typeof uid !== 'number' || Number.isNaN(uid)) {
      logger.warn(`getCashBalance: 无效的uid: ${uid}`)
      return 0
    }

    try {
      // @ts-ignore - monetary 表由 koishi-plugin-monetary 插件定义
      const records = await ctx.database.get('monetary', { uid, currency })
      logger.info(`getCashBalance: uid=${uid}, currency=${currency}, records=${JSON.stringify(records)}`)
      
      if (records && records.length > 0) {
        const value = Number(records[0].value || 0)
        return Number.isNaN(value) ? 0 : value
      }
      return 0
    } catch (err) {
      logger.error(`getCashBalance 失败: uid=${uid}, currency=${currency}`, err)
      return 0
    }
  }

  /**
   * 修改现金余额
   */
  async function changeCashBalance(uid: number, currency: string, delta: number): Promise<boolean> {
    if (!uid || typeof uid !== 'number' || Number.isNaN(uid)) {
      logger.warn(`changeCashBalance: 无效的uid: ${uid}`)
      return false
    }

    try {
      // @ts-ignore
      const records = await ctx.database.get('monetary', { uid, currency })
      
      if (!records || records.length === 0) {
        // 记录不存在，尝试创建
        if (delta < 0) return false // 无法扣款
        try {
          // @ts-ignore
          await ctx.database.create('monetary', { uid, currency, value: delta })
          logger.info(`changeCashBalance: 创建新记录 uid=${uid}, currency=${currency}, value=${delta}`)
          return true
        } catch (createErr) {
          logger.error(`changeCashBalance 创建记录失败:`, createErr)
          return false
        }
      }

      const current = Number(records[0].value || 0)
      // 保留两位小数，避免浮点数精度丢失
      const newValue = Number((current + delta).toFixed(2))
      
      if (newValue < 0) {
        logger.warn(`changeCashBalance: 余额不足 current=${current}, delta=${delta}`)
        return false
      }

      // @ts-ignore
      await ctx.database.set('monetary', { uid, currency }, { value: newValue })
      logger.info(`changeCashBalance: uid=${uid}, currency=${currency}, ${current} -> ${newValue}`)
      return true
    } catch (err) {
      logger.error(`changeCashBalance 失败: uid=${uid}, currency=${currency}, delta=${delta}`, err)
      return false
    }
  }

  /**
   * 获取银行活期余额（直接查询 monetary_bank_int 表）
   */
  async function getBankDemandBalance(uid: number, currency: string): Promise<number> {
    if (!uid || typeof uid !== 'number' || Number.isNaN(uid)) return 0

    try {
      // 检查表是否存在
      const tables = ctx.database.tables
      if (!tables || !('monetary_bank_int' in tables)) {
        logger.info('getBankDemandBalance: monetary_bank_int 表不存在')
        return 0
      }

      const records = await ctx.database.get('monetary_bank_int', { uid, currency, type: 'demand' })
      logger.info(`getBankDemandBalance: uid=${uid}, currency=${currency}, records=${records.length}`)
      
      let total = 0
      for (const record of records) {
        total += Number(record.amount || 0)
      }
      return total
    } catch (err) {
      logger.warn(`getBankDemandBalance 失败: uid=${uid}`, err)
      return 0
    }
  }

  /**
   * 从银行活期扣款
   */
  async function deductBankDemand(uid: number, currency: string, amount: number): Promise<boolean> {
    if (!uid || typeof uid !== 'number' || Number.isNaN(uid) || amount <= 0) return false

    try {
      const tables = ctx.database.tables
      if (!tables || !('monetary_bank_int' in tables)) return false

      // 按结算日期顺序获取活期记录
      const demandRecords = await ctx.database
        .select('monetary_bank_int')
        .where({ uid, currency, type: 'demand' })
        .orderBy('settlementDate', 'asc')
        .execute()

      let remaining = Number(amount.toFixed(2))
      for (const record of demandRecords) {
        if (remaining <= 0) break

        if (record.amount <= remaining) {
          remaining = Number((remaining - record.amount).toFixed(2))
          await ctx.database.remove('monetary_bank_int', { id: record.id })
        } else {
          const newAmount = Number((record.amount - remaining).toFixed(2))
          await ctx.database.set('monetary_bank_int', { id: record.id }, { amount: newAmount })
          remaining = 0
        }
      }

      logger.info(`deductBankDemand: uid=${uid}, amount=${amount}, remaining=${remaining}`)
      return remaining === 0
    } catch (err) {
      logger.error(`deductBankDemand 失败:`, err)
      return false
    }
  }

  /**
   * 综合支付函数：优先扣除现金，不足部分扣除银行活期
   */
  async function pay(uid: number, cost: number, currency: string): Promise<{ success: boolean; msg?: string }> {
    logger.info(`pay: uid=${uid}, cost=${cost}, currency=${currency}`)
    
    const cash = await getCashBalance(uid, currency)
    const bankDemand = await getBankDemandBalance(uid, currency)

    logger.info(`pay: 现金=${cash}, 活期=${bankDemand}, 需要=${cost}`)

    if (cash + bankDemand < cost) {
      return { success: false, msg: `资金不足！需要 ${cost.toFixed(2)}，当前现金 ${cash.toFixed(2)} + 活期 ${bankDemand.toFixed(2)}` }
    }

    let remainingCost = Number(cost.toFixed(2))
    
    // 1. 扣除现金
    const cashDeduct = Number(Math.min(cash, remainingCost).toFixed(2))
    if (cashDeduct > 0) {
      const success = await changeCashBalance(uid, currency, -cashDeduct)
      if (!success) return { success: false, msg: '扣除现金失败，请重试' }
      remainingCost = Number((remainingCost - cashDeduct).toFixed(2))
    }

    // 2. 扣除银行活期
    if (remainingCost > 0) {
      const success = await deductBankDemand(uid, currency, remainingCost)
      if (!success) {
        // 回滚现金扣除
        if (cashDeduct > 0) await changeCashBalance(uid, currency, cashDeduct)
        return { success: false, msg: '银行活期扣款失败' }
      }
    }

    return { success: true }
  }

  // --- 宏观调控逻辑 ---

  // K线形态模型库（日内短线模型）
  // 每个模型返回一个函数，根据日内进度(0-1)返回相对价格偏移系数(-1到1)
  const kLinePatterns = {
    // 1. 早盘冲高回落：开盘上涨，午后回落
    morningRally: (p: number) => {
      if (p < 0.3) return Math.sin(p / 0.3 * Math.PI / 2) * 1.0
      return Math.cos((p - 0.3) / 0.7 * Math.PI / 2) * 0.6
    },
    // 2. 早盘低开高走：开盘下跌，之后持续上涨
    vShape: (p: number) => {
      if (p < 0.25) return -Math.sin(p / 0.25 * Math.PI / 2) * 0.8
      return -0.8 + (p - 0.25) / 0.75 * 1.6
    },
    // 3. 倒V型：持续上涨后快速下跌
    invertedV: (p: number) => {
      if (p < 0.6) return Math.sin(p / 0.6 * Math.PI / 2) * 1.0
      return Math.cos((p - 0.6) / 0.4 * Math.PI / 2) * 1.0
    },
    // 4. 震荡整理：小幅波动，无明显方向
    consolidation: (p: number) => {
      return Math.sin(p * Math.PI * 4) * 0.3 + Math.sin(p * Math.PI * 7) * 0.15
    },
    // 5. 阶梯上涨：分段上涨，有回调
    stairUp: (p: number) => {
      const step = Math.floor(p * 4)
      const inStep = (p * 4) % 1
      const base = step * 0.25
      const stepMove = inStep < 0.7 ? Math.sin(inStep / 0.7 * Math.PI / 2) * 0.3 : 0.3 - (inStep - 0.7) / 0.3 * 0.1
      return base + stepMove
    },
    // 6. 阶梯下跌：分段下跌，有反弹
    stairDown: (p: number) => {
      const step = Math.floor(p * 4)
      const inStep = (p * 4) % 1
      const base = -step * 0.25
      const stepMove = inStep < 0.7 ? -Math.sin(inStep / 0.7 * Math.PI / 2) * 0.3 : -0.3 + (inStep - 0.7) / 0.3 * 0.1
      return base + stepMove
    },
    // 7. 尾盘拉升：前期平稳，尾盘快速上涨
    lateRally: (p: number) => {
      if (p < 0.7) return Math.sin(p / 0.7 * Math.PI * 2) * 0.2
      return (p - 0.7) / 0.3 * 1.0
    },
    // 8. 尾盘跳水：前期平稳或上涨，尾盘快速下跌
    lateDive: (p: number) => {
      if (p < 0.7) return Math.sin(p / 0.7 * Math.PI / 2) * 0.4
      return 0.4 - (p - 0.7) / 0.3 * 1.2
    },
    // 9. W底：双底形态
    doubleBottom: (p: number) => {
      if (p < 0.25) return -Math.sin(p / 0.25 * Math.PI / 2) * 0.8
      if (p < 0.5) return -0.8 + Math.sin((p - 0.25) / 0.25 * Math.PI / 2) * 0.5
      if (p < 0.75) return -0.3 - Math.sin((p - 0.5) / 0.25 * Math.PI / 2) * 0.5
      return -0.8 + (p - 0.75) / 0.25 * 1.2
    },
    // 10. M顶：双顶形态
    doubleTop: (p: number) => {
      if (p < 0.25) return Math.sin(p / 0.25 * Math.PI / 2) * 0.8
      if (p < 0.5) return 0.8 - Math.sin((p - 0.25) / 0.25 * Math.PI / 2) * 0.5
      if (p < 0.75) return 0.3 + Math.sin((p - 0.5) / 0.25 * Math.PI / 2) * 0.5
      return 0.8 - (p - 0.75) / 0.25 * 1.2
    },
    // 11. 单边上涨
    bullish: (p: number) => {
      return Math.sin(p * Math.PI / 2) * 0.8 + Math.sin(p * Math.PI * 3) * 0.1
    },
    // 12. 单边下跌
    bearish: (p: number) => {
      return -Math.sin(p * Math.PI / 2) * 0.8 + Math.sin(p * Math.PI * 3) * 0.1
    }
  }

  const patternNames = Object.keys(kLinePatterns) as (keyof typeof kLinePatterns)[]
  
  // K线模型中文名映射
  const patternChineseNames: Record<keyof typeof kLinePatterns, string> = {
    morningRally: '早盘冲高回落',
    vShape: 'V型反转',
    invertedV: '倒V型',
    consolidation: '震荡整理',
    stairUp: '阶梯上涨',
    stairDown: '阶梯下跌',
    lateRally: '尾盘拉升',
    lateDive: '尾盘跳水',
    doubleBottom: 'W底(双底)',
    doubleTop: 'M顶(双顶)',
    bullish: '单边上涨',
    bearish: '单边下跌'
  }

  // 当前使用的K线模型（开市时自动切换）
  let currentDayPattern: keyof typeof kLinePatterns = patternNames[Math.floor(Math.random() * patternNames.length)]
  // 记录上次切换时间和下次计划切换时间（用于随机时间切换）
  let lastPatternSwitchTime = new Date()
  // 初始化下次切换时间：当前时间 + 随机时长 (1-6小时)
  let nextPatternSwitchTime = new Date(Date.now() + (1 + Math.random() * 5) * 3600 * 1000)

  // 切换K线模型的函数
  function switchKLinePattern(reason: string) {
    const oldPattern = currentDayPattern
    currentDayPattern = patternNames[Math.floor(Math.random() * patternNames.length)]
    const now = new Date()
    lastPatternSwitchTime = now
    // 重置下次切换时间（1-6小时后）
    const minDuration = 1 * 3600 * 1000
    const randomDuration = Math.random() * 5 * 3600 * 1000
    nextPatternSwitchTime = new Date(now.getTime() + minDuration + randomDuration)
    logger.info(`${reason}切换K线模型: ${patternChineseNames[oldPattern]}(${oldPattern}) -> ${patternChineseNames[currentDayPattern]}(${currentDayPattern}), 下次随机切换: ${nextPatternSwitchTime.toLocaleString()}`)
  }

  async function updatePrice() {
    // 获取当前调控状态
    let state = (await ctx.database.get('bourse_state', { key: 'macro_state' }))[0]
    const now = __testNow ?? new Date()

    // 确保时间类型正确
    if (state) {
      if (!state.lastCycleStart) state.lastCycleStart = new Date(Date.now() - 7 * 24 * 3600 * 1000)
      if (!(state.lastCycleStart instanceof Date)) state.lastCycleStart = new Date(state.lastCycleStart)
      
      if (!state.endTime) state.endTime = new Date(state.lastCycleStart.getTime() + 7 * 24 * 3600 * 1000)
      if (!(state.endTime instanceof Date)) state.endTime = new Date(state.endTime)
    }

    // 状态初始化或过期检查（手动与自动到期都应切换为自动新周期）
    let needNewState = false
    if (!state) {
      needNewState = true
    } else {
      const endTime = state.endTime || new Date(state.lastCycleStart.getTime() + 7 * 24 * 3600 * 1000)
      if (now > endTime) needNewState = true
    }

    const createAutoState = async () => {
      const durationHours = 7 * 24 // 一周周期
      const fluctuation = 0.25 // 周目标波动范围±25%
      const targetRatio = 1 + (Math.random() * 2 - 1) * fluctuation
      let targetPrice = currentPrice * targetRatio
      
      // 限幅
      targetPrice = Math.max(currentPrice * 0.5, Math.min(currentPrice * 1.5, targetPrice))
      
      const endTime = new Date(now.getTime() + durationHours * 3600 * 1000)

      const newState: BourseState = {
        key: 'macro_state',
        lastCycleStart: now,
        startPrice: currentPrice,
        targetPrice,
        trendFactor: 0, // 不再使用线性趋势因子
        mode: 'auto',
        endTime
      }
      if (!state) await ctx.database.create('bourse_state', newState)
      else {
        const { key, ...updateFields } = newState
        await ctx.database.set('bourse_state', { key: 'macro_state' }, updateFields)
      }
      state = newState
    }

    if (needNewState) {
      await createAutoState()
    } else if (state.mode === 'auto' && nextMacroSwitchTime && now >= nextMacroSwitchTime) {
      const hours = 6 + Math.floor(Math.random() * 19)
      nextMacroSwitchTime = new Date(now.getTime() + hours * 3600 * 1000)
      await createAutoState()
    }

    // K线模型切换
    const timeSinceLastSwitch = now.getTime() - lastPatternSwitchTime.getTime()
    const forceSwitchDuration = 30 * 3600 * 1000
    if (now >= nextPatternSwitchTime || timeSinceLastSwitch > forceSwitchDuration) {
      switchKLinePattern('随机时间')
    }

    // ============================================================
    // 真实股票走势模拟（几何布朗运动 + 均值回归 + 日内形态）
    // ============================================================
    
    // --- 基础参数 ---
    const basePrice = state.startPrice
    const targetPrice = state.targetPrice
    const totalDuration = state.endTime.getTime() - state.lastCycleStart.getTime()
    const elapsed = now.getTime() - state.lastCycleStart.getTime()
    const cycleProgress = Math.max(0, Math.min(1, elapsed / totalDuration))
    
    // --- 日内时间进度 ---
    const dayStart = new Date(now)
    dayStart.setHours(config.openHour, 0, 0, 0)
    const dayEnd = new Date(now)
    dayEnd.setHours(config.closeHour, 0, 0, 0)
    const dayDuration = dayEnd.getTime() - dayStart.getTime()
    const dayElapsed = now.getTime() - dayStart.getTime()
    const dayProgress = Math.max(0, Math.min(1, dayElapsed / dayDuration))

    // ============================================================
    // 1. 宏观漂移项（Drift）- 向目标价格的均值回归（融入周波浪）
    // ============================================================
    // 当前应有价格 = 基准价 → 目标价的线性插值，并叠加周波浪偏置（对目标的轻微偏移）
    const expectedBase = basePrice + (targetPrice - basePrice) * cycleProgress
    // 周期波浪以偏置形式作用于“应有价格”，而非直接作为收益项
    const wavePhaseForMean = 2 * Math.PI * macroWaveCount * cycleProgress
    const weeklyAmplitudeRatioForMean = Math.min(Math.max(macroWeeklyAmplitudeRatio, 0.04), 0.12) // 收敛至4%-12%（增强波浪感）
    const waveMeanBias = Math.sin(wavePhaseForMean) * weeklyAmplitudeRatioForMean
    const expectedPrice = expectedBase * (1 + waveMeanBias)
    
    // 回归力度：价格偏离越大，回归力越强
    const deviation = (expectedPrice - currentPrice) / currentPrice
    const meanReversionStrength = 0.05 // 增强回归强度（每tick回归5%的偏差）
    const driftReturn = deviation * meanReversionStrength

    // ============================================================
    // 2. 波动率项（Volatility）- 基于日内时段变化
    // ============================================================
    // 真实股票的波动率在一天中不同时段是不同的
    // 开盘和收盘波动大，午盘相对平静
    const getVolatility = (progress: number): number => {
      // U型波动率曲线：开盘高、午盘低、尾盘高
      const morningVol = Math.exp(-8 * progress) // 开盘后快速下降
      const afternoonVol = Math.exp(-8 * (1 - progress)) // 收盘前快速上升
      const baseVol = 0.3 // 基础波动率
      return baseVol + morningVol * 0.5 + afternoonVol * 0.4
    }
    
    const volatility = getVolatility(dayProgress)
    
    // ============================================================
    // 3. 随机项（Random Walk）- 几何布朗运动
    // ============================================================
    // 使用Box-Muller变换生成标准正态分布随机数
    const u1 = Math.random()
    const u2 = Math.random()
    const normalRandom = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    
    // 基础波动幅度（每2分钟约0.25%的标准差，增强波动感）
    const baseVolatilityPerTick = 0.0025
    const randomReturn = normalRandom * baseVolatilityPerTick * volatility

    // ============================================================
    // 4. K线形态项 - 叠加日内趋势偏好
    // ============================================================
    // K线形态提供一个微小的方向性偏置，而非直接决定价格
    const patternFn = kLinePatterns[currentDayPattern]
    const patternValue = patternFn(dayProgress)
    const prevPatternValue = patternFn(Math.max(0, dayProgress - 0.01))
    const patternTrend = (patternValue - prevPatternValue) * 0.8 // 形态变化的方向（增强）
    const patternBias = patternTrend * 0.008 // 转化为更显著的收益率偏置

    // ============================================================
    // 5/6. 合成收益率并计算新价格（移除波浪收益项，波浪已作用于均值目标）
    // ============================================================
    // 总收益率 = 漂移 + 随机 + 形态偏置
    const totalReturn = driftReturn + randomReturn + patternBias
    
    // 使用几何收益率计算新价格（保证价格始终为正）
    let newPrice = currentPrice * (1 + totalReturn)
    
    // ============================================================
    // 7. 涨跌幅限制（相对于周期起始价和日开盘价）
    // ============================================================
    const dayBase = dailyOpenPrice ?? basePrice
    const weekUpper = basePrice * 1.5
    const weekLower = basePrice * 0.5
    const dayUpper = dayBase * 1.5
    const dayLower = dayBase * 0.5
    
    const upperLimit = Math.min(weekUpper, dayUpper)
    const lowerLimit = Math.max(weekLower, dayLower)
    
    // 软着陆：接近限幅时逐渐减缓而非硬切
    if (newPrice > upperLimit * 0.95) {
      const overshoot = (newPrice - upperLimit * 0.95) / (upperLimit * 0.05)
      newPrice = upperLimit * 0.95 + (upperLimit * 0.05) * Math.tanh(overshoot)
    }
    if (newPrice < lowerLimit * 1.05) {
      const undershoot = (lowerLimit * 1.05 - newPrice) / (lowerLimit * 0.05)
      newPrice = lowerLimit * 1.05 - (lowerLimit * 0.05) * Math.tanh(undershoot)
    }
    
    newPrice = Math.max(lowerLimit, Math.min(upperLimit, newPrice))
    
    // 最低价格保护
    if (newPrice < 1) newPrice = 1
    
    // 保留两位小数
    newPrice = Number(newPrice.toFixed(2))
    currentPrice = newPrice
    await ctx.database.create('bourse_history', { stockId, price: newPrice, time: new Date() })
  }

  // --- 交易处理逻辑 ---

  async function processPendingTransactions() {
    const now = new Date()
    const pending = await ctx.database.get('bourse_pending', { endTime: { $lte: now } })

    for (const txn of pending) {
      if (txn.type === 'buy') {
        // 买入解冻：增加持仓和总成本
        const holding = await ctx.database.get('bourse_holding', { userId: txn.userId, stockId })
        if (holding.length === 0) {
          await ctx.database.create('bourse_holding', { 
            userId: txn.userId, 
            stockId, 
            amount: txn.amount,
            totalCost: Number(txn.cost.toFixed(2))
          })
        } else {
          // 兼容旧版本数据：totalCost 可能为 undefined 或 null 或 0
          // 关键修复：如果旧数据没有成本记录，用【交易时的单价】估算旧持仓成本
          // 这样新旧数据合并时不会造成成本稀释
          let existingCost = holding[0].totalCost
          if (!existingCost || existingCost <= 0) {
            // 用交易时的单价估算旧持仓成本（比用当前市价更准确，因为交易时价格更接近用户买入时的价格）
            existingCost = Number((holding[0].amount * txn.price).toFixed(2))
            logger.info(`processPendingTransactions: 旧持仓无成本记录，使用交易价格估算: ${holding[0].amount}股 * ${txn.price} = ${existingCost}`)
          }
          const newTotalCost = Number((existingCost + txn.cost).toFixed(2))
          await ctx.database.set('bourse_holding', { userId: txn.userId, stockId }, { 
            amount: holding[0].amount + txn.amount,
            totalCost: newTotalCost
          })
        }
      } else if (txn.type === 'sell') {
        // 卖出解冻：增加现金
        // 使用存储的数字uid
        if (txn.uid && typeof txn.uid === 'number') {
          // 保留两位小数
          const amount = Number(txn.cost.toFixed(2))
          await changeCashBalance(txn.uid, config.currency, amount)
        } else {
          logger.warn(`processPendingTransactions: 卖出订单缺少有效uid, txn.id=${txn.id}`)
        }
      }
      await ctx.database.remove('bourse_pending', { id: txn.id })
    }
  }

  // --- 命令定义 ---

  ctx.command('stock [interval:string]', '查看股市行情')
    .action(async ({ session }, interval) => {
      // 修复：如果 interval 是子指令关键字，则手动转发（防止被当做参数捕获）
      if (['buy', 'sell', 'my'].includes(interval)) {
        const parts = session.content.trim().split(/\s+/).slice(2)
        const rest = parts.join(' ')
        return session.execute(`stock.${interval} ${rest}`)
      }

      if (!await isMarketOpen()) return '股市目前休市中。（开放时间：工作日 ' + config.openHour + ':00 - ' + config.closeHour + ':00）'
      
      let history: BourseHistory[]
      const now = new Date()
      
      if (interval === 'day') {
        const startTime = new Date(now.getTime() - 24 * 3600 * 1000)
        history = await ctx.database.get('bourse_history', { 
          stockId, 
          time: { $gte: startTime } 
        }, { sort: { time: 'asc' } })
      } else if (interval === 'week') {
        const startTime = new Date(now.getTime() - 7 * 24 * 3600 * 1000)
        history = await ctx.database.get('bourse_history', { 
          stockId, 
          time: { $gte: startTime } 
        }, { sort: { time: 'asc' } })
      } else {
        // 默认实时（最近100条）
        history = await ctx.database.get('bourse_history', { stockId }, { 
          limit: 100, 
          sort: { time: 'desc' } 
        })
        history = history.reverse()
      }
      
      if (history.length === 0) return '暂无行情数据。'
      
      // 数据采样（如果数据量过大）
      if (history.length > 300) {
        const step = Math.ceil(history.length / 300)
        history = history.filter((_, index) => index % step === 0)
      }
      
      const latest = history[history.length - 1]
      
      // Adjust time format for chart
      const formattedData = history.map(h => {
         let timeStr = h.time.toLocaleTimeString()
         if (interval === 'week' || interval === 'day') {
             // For longer durations, include Month/Day
             timeStr = `${h.time.getMonth()+1}-${h.time.getDate()} ${h.time.getHours()}:${h.time.getMinutes().toString().padStart(2, '0')}`
         }
         return {
             time: timeStr,
             price: h.price,
             timestamp: h.time.getTime()
         }
      })
      
      const high = Math.max(...formattedData.map(d => d.price))
      const low = Math.min(...formattedData.map(d => d.price))
      
      const viewLabel = interval === 'week' ? '周走势' : interval === 'day' ? '日走势' : '实时走势'
      
      const img = await renderStockImage(ctx, formattedData, config.stockName, viewLabel, latest.price, high, low)
      return img
    })

  ctx.command('stock.buy <amount:number>', '买入股票')
    .userFields(['id'])
    .action(async ({ session }, amount) => {
      if (!amount || amount <= 0 || !Number.isInteger(amount)) return '请输入有效的购买股数（整数）。'
      if (!await isMarketOpen()) return '休市中，无法交易。'

      // 使用 session.user.id 获取数字类型的用户ID
      const uid = session.user?.id
      const visibleUserId = session.userId // 用于持仓记录
      
      if (!uid || typeof uid !== 'number') {
        return '无法获取用户ID，请稍后重试。'
      }

      const cost = Number((currentPrice * amount).toFixed(2))
      
      // 支付流程：现金 + 银行活期
      const payResult = await pay(uid, cost, config.currency)
      if (!payResult.success) {
        return payResult.msg
      }

      // 计算冻结时间（按交易金额计算）
      // 注意：maxFreezeTime=0 表示无冻结，直接完成交易
      let freezeMinutes = 0
      if (config.maxFreezeTime > 0) {
        freezeMinutes = cost / config.freezeCostPerMinute
        // 先限制最大值，再限制最小值（确保最小值优先）
        if (freezeMinutes > config.maxFreezeTime) freezeMinutes = config.maxFreezeTime
        if (freezeMinutes < config.minFreezeTime) freezeMinutes = config.minFreezeTime
      }
      const freezeMs = freezeMinutes * 60 * 1000
      
      // 检查用户是否有其他挂单，如果有则排队（由前往后依次读秒）
      const userPendingOrders = await ctx.database.get('bourse_pending', { userId: visibleUserId }, { sort: { endTime: 'desc' }, limit: 1 })
      let startTime = new Date()
      if (userPendingOrders.length > 0) {
        const lastOrderEndTime = userPendingOrders[0].endTime
        if (lastOrderEndTime > startTime) {
          startTime = lastOrderEndTime // 新挂单从上一个挂单结束后开始计时
        }
      }
      const endTime = new Date(startTime.getTime() + freezeMs)

      await ctx.database.create('bourse_pending', {
        userId: visibleUserId,
        uid,
        stockId,
        type: 'buy',
        amount,
        price: currentPrice,
        cost,
        startTime,
        endTime
      })

      // 如果冻结时间为0，立即处理挂单（不等待定时任务）
      if (freezeMinutes === 0) {
        await processPendingTransactions()
        return `交易已完成！\n花费: ${cost.toFixed(2)} ${config.currency}\n股票已到账。`
      }

      return `交易申请已提交！\n花费: ${cost.toFixed(2)} ${config.currency}\n冻结时间: ${freezeMinutes.toFixed(1)}分钟\n股票将在解冻后到账。`
    })

  ctx.command('stock.sell <amount:number>', '卖出股票')
    .userFields(['id'])
    .action(async ({ session }, amount) => {
      if (!amount || amount <= 0 || !Number.isInteger(amount)) return '请输入有效的卖出股数。'
      if (!await isMarketOpen()) return '休市中，无法交易。'

      const uid = session.user?.id
      const visibleUserId = session.userId
      
      if (!uid || typeof uid !== 'number') {
        return '无法获取用户ID，请稍后重试。'
      }

      const holding = await ctx.database.get('bourse_holding', { userId: visibleUserId, stockId })

      if (holding.length === 0 || holding[0].amount < amount) {
        return `持仓不足！当前持有: ${holding.length ? holding[0].amount : 0} 股。`
      }

      // 计算卖出部分对应的成本（按比例扣减）
      const currentHolding = holding[0]
      // 兼容旧版本数据：totalCost 可能为 undefined 或 null 或 0
      // 如果没有成本记录，用当前市价估算（这样卖出后盈亏显示为0，符合预期）
      let existingTotalCost = currentHolding.totalCost
      if (!existingTotalCost || existingTotalCost <= 0) {
        existingTotalCost = Number((currentHolding.amount * currentPrice).toFixed(2))
        logger.info(`stock.sell: 旧持仓无成本记录，使用当前市价估算: ${currentHolding.amount}股 * ${currentPrice} = ${existingTotalCost}`)
      }
      const avgCostPerShare = Number((existingTotalCost / currentHolding.amount).toFixed(2))
      const soldCost = Number((avgCostPerShare * amount).toFixed(2))

      // 立即扣减持仓和对应成本
      const newAmount = currentHolding.amount - amount
      if (newAmount === 0) {
        await ctx.database.remove('bourse_holding', { userId: visibleUserId, stockId })
      } else {
        const newTotalCost = Number((existingTotalCost - soldCost).toFixed(2))
        await ctx.database.set('bourse_holding', { userId: visibleUserId, stockId }, { 
          amount: newAmount,
          totalCost: Math.max(0, newTotalCost) // 确保不为负数
        })
      }

      // 计算收益
      const gain = Number((currentPrice * amount).toFixed(2))
      // 计算冻结时间（按交易金额计算）
      // 注意：maxFreezeTime=0 表示无冻结，直接完成交易
      let freezeMinutes = 0
      if (config.maxFreezeTime > 0) {
        freezeMinutes = gain / config.freezeCostPerMinute
        // 先限制最大值，再限制最小值（确保最小值优先）
        if (freezeMinutes > config.maxFreezeTime) freezeMinutes = config.maxFreezeTime
        if (freezeMinutes < config.minFreezeTime) freezeMinutes = config.minFreezeTime
      }
      const freezeMs = freezeMinutes * 60 * 1000
      
      // 检查用户是否有其他挂单，如果有则排队（由前往后依次读秒）
      const userPendingOrders = await ctx.database.get('bourse_pending', { userId: visibleUserId }, { sort: { endTime: 'desc' }, limit: 1 })
      let startTime = new Date()
      if (userPendingOrders.length > 0) {
        const lastOrderEndTime = userPendingOrders[0].endTime
        if (lastOrderEndTime > startTime) {
          startTime = lastOrderEndTime // 新挂单从上一个挂单结束后开始计时
        }
      }
      const endTime = new Date(startTime.getTime() + freezeMs)

      await ctx.database.create('bourse_pending', {
        userId: visibleUserId,
        uid,
        stockId,
        type: 'sell',
        amount,
        price: currentPrice,
        cost: gain,
        startTime,
        endTime
      })

      // 如果冻结时间为0，立即处理挂单（不等待定时任务）
      if (freezeMinutes === 0) {
        await processPendingTransactions()
        return `卖出已完成！\n收益: ${gain.toFixed(2)} ${config.currency}\n资金已到账。`
      }

      return `卖出挂单已提交！\n预计收益: ${gain.toFixed(2)} ${config.currency}\n资金冻结: ${freezeMinutes.toFixed(1)}分钟\n资金将在解冻后到账。`
    })

  ctx.command('stock.my', '我的持仓')
    .action(async ({ session }) => {
      const userId = session.userId
      const holdings = await ctx.database.get('bourse_holding', { userId })
      const pending = await ctx.database.get('bourse_pending', { userId })

      // 计算持仓信息
      let holdingData = null
      if (holdings.length > 0) {
        const h = holdings[0]
        const marketValue = Number((h.amount * currentPrice).toFixed(2))
        // 兼容旧版本数据：totalCost 可能为 undefined 或 null 或 0
        const hasCostData = h.totalCost !== undefined && h.totalCost !== null && h.totalCost > 0
        const totalCost = hasCostData ? Number(h.totalCost.toFixed(2)) : 0
        const avgCost = hasCostData && h.amount > 0 ? Number((totalCost / h.amount).toFixed(2)) : 0
        const profit = hasCostData ? Number((marketValue - totalCost).toFixed(2)) : null
        const profitPercent = hasCostData && totalCost > 0 ? Number(((profit / totalCost) * 100).toFixed(2)) : null
        
        holdingData = {
          stockName: config.stockName,
          amount: h.amount,
          currentPrice: Number(currentPrice.toFixed(2)),
          avgCost: hasCostData ? avgCost : null, // null 表示无成本记录
          totalCost: hasCostData ? totalCost : null,
          marketValue,
          profit,
          profitPercent
        }
      }

      // 处理进行中的交易
      const pendingData = pending.map(p => {
        const timeLeft = Math.max(0, Math.ceil((p.endTime.getTime() - Date.now()) / 1000))
        const minutes = Math.floor(timeLeft / 60)
        const seconds = timeLeft % 60
        return {
          type: p.type === 'buy' ? '买入' : '卖出',
          typeClass: p.type,
          amount: p.amount,
          price: Number(p.price.toFixed(2)),
          cost: Number(p.cost.toFixed(2)),
          timeLeft: `${minutes}分${seconds}秒`
        }
      })

      // 渲染 HTML 图片
      const img = await renderHoldingImage(ctx, session.username, holdingData, pendingData, config.currency)
      return img
    })

  ctx.command('stock.control <price:number> [hours:number]', '管理员：设置宏观调控目标', { authority: 3 })
    .action(async ({ session }, price, hours) => {
      if (!price || price <= 0) return '请输入有效的目标价格。'
      const duration = hours || 24 // 默认24小时
      
      const now = new Date()
      const endTime = new Date(now.getTime() + duration * 3600 * 1000)
      
      // 新的手动调控：开启一个全新周期，避免与旧周期叠加造成停滞
      const baseStart = currentPrice
      const dayBase = dailyOpenPrice ?? baseStart
      const upper = Math.min(baseStart * 1.5, dayBase * 1.5)
      const lower = Math.max(baseStart * 0.5, dayBase * 0.5)
      const targetPriceClamped = Math.max(lower, Math.min(upper, price))
      
      const minutes = duration * 60
      const trendFactor = (targetPriceClamped - currentPrice) / minutes
      
      const newState: BourseState = {
        key: 'macro_state',
        lastCycleStart: now,          // 开启新周期
        startPrice: currentPrice,     // 以当前价作为新基准
        targetPrice: targetPriceClamped,
        trendFactor,
        mode: 'manual',
        endTime
      }
      
      // 写入数据库
      const existing = await ctx.database.get('bourse_state', { key: 'macro_state' })
      if (existing.length === 0) {
        await ctx.database.create('bourse_state', newState)
      } else {
        const { key, ...updateFields } = newState
        await ctx.database.set('bourse_state', { key: 'macro_state' }, updateFields)
      }
      
      // 立即触发一次更新以应用新状态（可选，这里仅更新状态）
      const hint = targetPriceClamped !== price ? `（已按±50%限幅从${price}调整为${Number(targetPriceClamped.toFixed(2))}）` : ''
      return `宏观调控已设置：\n目标价格：${Number(targetPriceClamped.toFixed(2))}${hint}\n期限：${duration}小时\n模式：手动干预\n到期后将自动切回随机调控。`
    })

  ctx.command('bourse.admin.market <status>', '设置股市开关状态 (open/close/auto)', { authority: 3 })
    .action(async ({ session }, status) => {
      if (!['open', 'close', 'auto'].includes(status)) return '无效状态，请使用 open, close, 或 auto'
      
      // 检查是否是从关闭状态变为开启
      const wasOpen = await isMarketOpen()
      
      const key = 'macro_state'
      const existing = await ctx.database.get('bourse_state', { key })
      if (existing.length === 0) {
         const now = new Date()
         await ctx.database.create('bourse_state', {
            key,
            lastCycleStart: now,
            startPrice: config.initialPrice,
            targetPrice: config.initialPrice,
            trendFactor: 0,
            mode: 'auto',
            endTime: new Date(now.getTime() + 24*3600*1000),
            marketOpenStatus: status as 'open' | 'close' | 'auto'
         })
      } else {
         await ctx.database.set('bourse_state', { key }, { marketOpenStatus: status as 'open' | 'close' | 'auto' })
      }
      
      // 如果是开市操作（从关闭变为开启），切换K线模型
      if (status === 'open' && !wasOpen) {
        switchKLinePattern('管理员开市')
        wasMarketOpen = true
      } else if (status === 'close') {
        wasMarketOpen = false
      }
      
      return `股市状态已设置为: ${status}`
    })

  ctx.command('stock.pattern', '管理员：强制切换K线模型', { authority: 3 })
    .action(() => {
      switchKLinePattern('管理员手动')
      return '已切换K线模型。'
    })

  // --- 开发测试命令（使用虚拟时间推进，需开启 enableDebug） ---
  ctx.command('bourse.test.price [ticks:number]', '开发测试：推进价格更新若干次并返回当前价格', { authority: 3 })
    .action(async ({ session }, ticks?) => {
      if (!config.enableDebug) return '调试模式未开启，请在插件配置中启用 enableDebug。'
      const n = typeof ticks === 'number' && ticks > 0 ? Math.min(ticks, 500) : 1
      const stepMs = 2 * 60 * 1000 // 每步2分钟
      const startNow = new Date()
      __testNow = new Date(startNow)
      let minP = currentPrice, maxP = currentPrice
      for (let i = 0; i < n; i++) {
        await updatePrice()
        minP = Math.min(minP, currentPrice)
        maxP = Math.max(maxP, currentPrice)
        __testNow = new Date(__testNow.getTime() + stepMs)
      }
      __testNow = null
      return `测试完成：推进${n}步（每步2分钟）\n当前价格：${Number(currentPrice.toFixed(2))}\n区间最高：${Number(maxP.toFixed(2))} 最低：${Number(minP.toFixed(2))}`
    })

  ctx.command('bourse.test.run <ticks:number> [step:number]', '开发测试：按虚拟时间推进并统计价格分布', { authority: 3 })
    .action(async ({ session }, ticks, step) => {
      if (!config.enableDebug) return '调试模式未开启，请在插件配置中启用 enableDebug。'
      const n = Math.max(1, Math.min(Number(ticks) || 1, 2000))
      const stepSec = Math.max(10, Math.min(Number(step) || 120, 3600)) // 默认120秒
      const stepMs = stepSec * 1000
      const startPrice = currentPrice
      let minP = startPrice, maxP = startPrice
      let clampHits = 0
      const startNow = new Date()
      __testNow = new Date(startNow)
      for (let i = 0; i < n; i++) {
        await updatePrice()
        const after = currentPrice
        minP = Math.min(minP, after)
        maxP = Math.max(maxP, after)
        // 粗略统计触及限幅（1%以内判为边界命中）
        const baseStart = (await ctx.database.get('bourse_state', { key: 'macro_state' }))[0]?.startPrice ?? after
        const dayBase = dailyOpenPrice ?? baseStart
        const upper = Math.min(baseStart * 1.5, dayBase * 1.5)
        const lower = Math.max(baseStart * 0.5, dayBase * 0.5)
        if (after >= upper * 0.99 || after <= lower * 1.01) clampHits++
        __testNow = new Date(__testNow.getTime() + stepMs)
      }
      __testNow = null
      const drift = Number((currentPrice - startPrice).toFixed(2))
      return `内部测试\n步数：${n}；步长：${stepSec}s\n起始：${startPrice.toFixed(2)}；结束：${currentPrice.toFixed(2)}（Δ=${drift}）\n最高：${maxP.toFixed(2)}；最低：${minP.toFixed(2)}\n接近限幅次数：${clampHits}`
    })

  ctx.command('bourse.test.manualThenAuto <target:number> [hours:number] [ticks:number]', '开发测试：手动周期后切回自动的连续性', { authority: 3 })
    .action(async ({ session }, target, hours, ticks) => {
      if (!config.enableDebug) return '调试模式未开启，请在插件配置中启用 enableDebug。'
      const dur = Math.max(1, Math.min(Number(hours) || 6, 48))
      const n = Math.max(10, Math.min(Number(ticks) || 300, 5000))
      // 设定手动目标
      await session?.execute?.(`stock.control ${target} ${dur}`)
      // 用虚拟时间推进 dur*30 步（2分钟/步 = dur小时）
      const stepMs = 2 * 60 * 1000
      __testNow = new Date()
      for (let i = 0; i < dur * 30; i++) {
        await updatePrice()
        __testNow = new Date(__testNow.getTime() + stepMs)
      }
      // 再推进 n 步，观察是否仍然运动
      const before = currentPrice
      for (let i = 0; i < n; i++) {
        await updatePrice()
        __testNow = new Date(__testNow.getTime() + stepMs)
      }
      const after = currentPrice
      __testNow = null
      const moved = Math.abs(after - before) >= 0.01
      return `手动→自动 测试\n目标=${target}，期限=${dur}小时\n手动结束价：${before.toFixed(2)}；后续${n}步结束：${after.toFixed(2)}\n是否继续波动：${moved ? '是' : '否（需检查）'}`
    })

  // // --- 开发测试命令 ---
  // ctx.command('bourse.test.price [ticks:number]', '开发测试：推进价格更新若干次并返回当前价格', { authority: 3 })
  //   .action(async ({ session }, ticks?) => {
  //     const n = typeof ticks === 'number' && ticks > 0 ? Math.min(ticks, 500) : 1
  //     for (let i = 0; i < n; i++) {
  //       await updatePrice()
  //     }
  //     return `测试完成：推进${n}次；当前价格：${Number(currentPrice.toFixed(2))}`
  //   })

  // --- 渲染逻辑 ---

  // 渲染持仓信息为 HTML 图片
  async function renderHoldingImage(
    ctx: Context, 
    username: string, 
    holding: {
      stockName: string
      amount: number
      currentPrice: number
      avgCost: number | null  // null 表示无成本记录
      totalCost: number | null
      marketValue: number
      profit: number | null
      profitPercent: number | null
    } | null,
    pending: {
      type: string
      typeClass: string
      amount: number
      price: number
      cost: number
      timeLeft: string
    }[],
    currency: string
  ) {
    // 判断是否有成本数据
    const hasCostData = holding && holding.totalCost !== null
    const isProfit = hasCostData ? holding.profit >= 0 : true
    const profitColor = isProfit ? '#d93025' : '#188038'
    const profitSign = isProfit ? '+' : ''

    // 根据是否有成本数据渲染不同的盈亏区域
    const profitSectionHtml = hasCostData ? `
          <div class="profit-section" style="background: ${isProfit ? 'rgba(217, 48, 37, 0.08)' : 'rgba(24, 128, 56, 0.08)'}">
            <div class="profit-label">盈亏</div>
            <div class="profit-value" style="color: ${profitColor}">
              ${profitSign}${holding.profit.toFixed(2)} ${currency}
              <span class="profit-percent">(${profitSign}${holding.profitPercent.toFixed(2)}%)</span>
            </div>
          </div>
    ` : `
          <div class="profit-section no-data" style="background: rgba(128, 128, 128, 0.08)">
            <div class="profit-label">盈亏</div>
            <div class="profit-value" style="color: #888">
              暂无成本记录
              <span class="profit-hint">（新交易后将自动记录）</span>
            </div>
          </div>
    `

    const holdingHtml = holding ? `
      <div class="section">
        <div class="section-title">📈 持仓详情</div>
        <div class="stock-card">
          <div class="stock-header">
            <div class="stock-name">${holding.stockName}</div>
            <div class="stock-amount">${holding.amount} 股</div>
          </div>
          <div class="stock-body">
            <div class="stat-row">
              <div class="stat-item">
                <div class="stat-label">现价</div>
                <div class="stat-value">${holding.currentPrice.toFixed(2)}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">成本价</div>
                <div class="stat-value">${hasCostData ? holding.avgCost.toFixed(2) : '--'}</div>
              </div>
            </div>
            <div class="stat-row">
              <div class="stat-item">
                <div class="stat-label">持仓成本</div>
                <div class="stat-value">${hasCostData ? holding.totalCost.toFixed(2) : '--'}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">市值</div>
                <div class="stat-value highlight">${holding.marketValue.toFixed(2)}</div>
              </div>
            </div>
          </div>
          ${profitSectionHtml}
        </div>
      </div>
    ` : `
      <div class="section">
        <div class="section-title">📈 持仓详情</div>
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <div class="empty-text">暂无持仓</div>
        </div>
      </div>
    `

    const pendingHtml = pending.length > 0 ? `
      <div class="section">
        <div class="section-title">⏳ 进行中的交易</div>
        ${pending.map(p => `
          <div class="pending-item ${p.typeClass}">
            <div class="pending-left">
              <span class="pending-type ${p.typeClass}">${p.type}</span>
              <span class="pending-amount">${p.amount} 股</span>
            </div>
            <div class="pending-center">
              <span class="pending-price">单价 ${p.price.toFixed(2)}</span>
              <span class="pending-cost">总额 ${p.cost.toFixed(2)}</span>
            </div>
            <div class="pending-right">
              <span class="pending-time">⏱ ${p.timeLeft}</span>
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''

    const html = `
    <html>
    <head>
      <style>
        body { 
          margin: 0; 
          padding: 20px; 
          font-family: 'Segoe UI', 'Microsoft YaHei', Roboto, sans-serif; 
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
          width: 450px; 
          box-sizing: border-box; 
        }
        .card { 
          background: white; 
          padding: 25px; 
          border-radius: 20px; 
          box-shadow: 0 20px 40px rgba(0,0,0,0.15); 
        }
        .header { 
          display: flex; 
          align-items: center; 
          gap: 12px;
          margin-bottom: 20px; 
          padding-bottom: 15px;
          border-bottom: 2px solid #f0f2f5;
        }
        .avatar {
          width: 48px;
          height: 48px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 20px;
          font-weight: bold;
        }
        .user-info {
          flex: 1;
        }
        .username { 
          font-size: 22px; 
          font-weight: 700; 
          color: #1a1a1a; 
        }
        .account-label {
          font-size: 13px;
          color: #888;
          margin-top: 2px;
        }
        .section {
          margin-bottom: 20px;
        }
        .section:last-child {
          margin-bottom: 0;
        }
        .section-title {
          font-size: 14px;
          font-weight: 600;
          color: #666;
          margin-bottom: 12px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .stock-card {
          background: #f8f9fc;
          border-radius: 16px;
          overflow: hidden;
        }
        .stock-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%);
          color: white;
        }
        .stock-name {
          font-size: 18px;
          font-weight: 700;
        }
        .stock-amount {
          font-size: 16px;
          font-weight: 600;
          background: rgba(255,255,255,0.2);
          padding: 4px 12px;
          border-radius: 20px;
        }
        .stock-body {
          padding: 16px 20px;
        }
        .stat-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 12px;
        }
        .stat-row:last-child {
          margin-bottom: 0;
        }
        .stat-item {
          text-align: center;
          flex: 1;
        }
        .stat-label {
          font-size: 12px;
          color: #888;
          margin-bottom: 4px;
        }
        .stat-value {
          font-size: 18px;
          font-weight: 700;
          color: #333;
        }
        .stat-value.highlight {
          color: #667eea;
        }
        .profit-section {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-top: 1px solid #eee;
        }
        .profit-label {
          font-size: 14px;
          font-weight: 600;
          color: #666;
        }
        .profit-value {
          font-size: 22px;
          font-weight: 800;
        }
        .profit-percent {
          font-size: 14px;
          font-weight: 600;
          margin-left: 6px;
        }
        .profit-hint {
          font-size: 12px;
          font-weight: 400;
          display: block;
          margin-top: 4px;
        }
        .profit-section.no-data .profit-value {
          font-size: 16px;
          font-weight: 600;
        }
        .empty-state {
          background: #f8f9fc;
          border-radius: 16px;
          padding: 40px 20px;
          text-align: center;
        }
        .empty-icon {
          font-size: 48px;
          margin-bottom: 12px;
        }
        .empty-text {
          font-size: 16px;
          color: #888;
        }
        .pending-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #f8f9fc;
          border-radius: 12px;
          padding: 14px 16px;
          margin-bottom: 10px;
          border-left: 4px solid #ccc;
        }
        .pending-item.buy {
          border-left-color: #d93025;
        }
        .pending-item.sell {
          border-left-color: #188038;
        }
        .pending-item:last-child {
          margin-bottom: 0;
        }
        .pending-left {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .pending-type {
          font-size: 12px;
          font-weight: 700;
          padding: 3px 8px;
          border-radius: 6px;
          color: white;
        }
        .pending-type.buy {
          background: #d93025;
        }
        .pending-type.sell {
          background: #188038;
        }
        .pending-amount {
          font-size: 15px;
          font-weight: 600;
          color: #333;
        }
        .pending-center {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
        }
        .pending-price, .pending-cost {
          font-size: 12px;
          color: #666;
        }
        .pending-right {
          text-align: right;
        }
        .pending-time {
          font-size: 13px;
          font-weight: 600;
          color: #f39c12;
        }
        .footer {
          margin-top: 20px;
          padding-top: 15px;
          border-top: 1px solid #f0f2f5;
          text-align: center;
          font-size: 11px;
          color: #bbb;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <div class="avatar">${username.charAt(0).toUpperCase()}</div>
          <div class="user-info">
            <div class="username">${username}</div>
            <div class="account-label">股票账户</div>
          </div>
        </div>
        ${holdingHtml}
        ${pendingHtml}
        <div class="footer">
          数据更新于 ${new Date().toLocaleString('zh-CN')}
        </div>
      </div>
    </body>
    </html>
    `

    const page = await ctx.puppeteer.page()
    await page.setContent(html)
    const element = await page.$('.card')
    const imgBuf = await element?.screenshot({ encoding: 'binary' })
    await page.close()
    
    return h.image(imgBuf, 'image/png')
  }
  
  async function renderStockImage(ctx: Context, data: {time: string, price: number, timestamp: number}[], name: string, viewLabel: string, current: number, high: number, low: number) {
    if (data.length < 2) return '数据不足，无法绘制走势图。'
    
    const startPrice = data[0].price
    const change = current - startPrice
    const changePercent = (change / startPrice) * 100
    const isUp = change >= 0
    
    // 读取 HTML 模板
    const templatePath = resolve(__dirname, 'templates', 'stock-chart.html')
    let html = await fs.readFile(templatePath, 'utf-8')
    
    // 配色方案：专业金融风格（参考 TradingView）
    // 涨: #089981 (Green), 跌: #f23645 (Red) - 国际惯例，或者国内惯例 涨红跌绿
    // 这里保持国内习惯：涨红(#f23645) 跌绿(#089981)
    const colorScheme = {
      mainColor: isUp ? '#f23645' : '#089981',
      gradientStart: isUp ? 'rgba(242, 54, 69, 0.25)' : 'rgba(8, 153, 129, 0.25)',
      gradientEnd: 'rgba(255, 255, 255, 0)',
      glowColor: isUp ? 'rgba(242, 54, 69, 0.4)' : 'rgba(8, 153, 129, 0.4)',
      iconGradientStart: isUp ? '#f23645' : '#089981',
      iconGradientEnd: isUp ? '#ff7e87' : '#40c2aa',
      iconShadow: isUp ? 'rgba(242, 54, 69, 0.3)' : 'rgba(8, 153, 129, 0.3)',
      changeBadgeBg: isUp ? 'rgba(242, 54, 69, 0.12)' : 'rgba(8, 153, 129, 0.12)'
    }
    
    // 替换模板变量
    const replacements: Record<string, string> = {
      '{{MAIN_COLOR}}': colorScheme.mainColor,
      '{{GRADIENT_START}}': colorScheme.gradientStart,
      '{{GRADIENT_END}}': colorScheme.gradientEnd,
      '{{GLOW_COLOR}}': colorScheme.glowColor,
      '{{ICON_GRADIENT_START}}': colorScheme.iconGradientStart,
      '{{ICON_GRADIENT_END}}': colorScheme.iconGradientEnd,
      '{{ICON_SHADOW}}': colorScheme.iconShadow,
      '{{CHANGE_BADGE_BG}}': colorScheme.changeBadgeBg,
      '{{STOCK_NAME}}': name,
      '{{VIEW_LABEL}}': viewLabel,
      '{{CURRENT_TIME}}': new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      '{{CURRENT_PRICE}}': current.toFixed(2),
      '{{CHANGE_VALUE}}': `${change >= 0 ? '+' : ''}${change.toFixed(2)}`,
      '{{CHANGE_ICON}}': change >= 0 ? '↑' : '↓',
      '{{CHANGE_PERCENT}}': Math.abs(changePercent).toFixed(2),
      '{{HIGH_PRICE}}': high.toFixed(2),
      '{{LOW_PRICE}}': low.toFixed(2),
      '{{AMPLITUDE}}': ((high - low) / startPrice * 100).toFixed(2),
      '{{START_PRICE}}': startPrice.toFixed(2),
      '{{UPDATE_TIME}}': new Date().toLocaleString('zh-CN'),
      '{{PRICES}}': JSON.stringify(data.map(d => d.price)),
      '{{TIMES}}': JSON.stringify(data.map(d => d.time)),
      '{{TIMESTAMPS}}': JSON.stringify(data.map(d => d.timestamp))
    }
    
    // 批量替换所有变量
    for (const [key, value] of Object.entries(replacements)) {
      html = html.replace(new RegExp(key, 'g'), value)
    }

    const page = await ctx.puppeteer.page()
    await page.setContent(html)
    const element = await page.$('.card')
    const imgBuf = await element?.screenshot({ encoding: 'binary' })
    await page.close()
    
    return h.image(imgBuf, 'image/png')
  }
}
