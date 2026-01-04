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
  // 手动调控
  enableManualControl: boolean
  manualTargetPrice: number
  manualDuration: number
  // 股市开关
  marketStatus: 'open' | 'close' | 'auto'
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
    enableManualControl: Schema.boolean().default(false).description('开启手动宏观调控(覆盖自动)'),
    manualTargetPrice: Schema.number().min(0.01).default(1000).description('手动目标价格'),
    manualDuration: Schema.number().min(1).default(24).description('手动调控周期(小时)'),
  }).description('手动宏观调控'),
])

// --- 核心实现 ---

export function apply(ctx: Context, config: Config) {
  // 1. 初始化数据库模型
  ctx.model.extend('bourse_holding', {
    id: 'unsigned',
    userId: 'string',
    stockId: 'string',
    amount: 'integer',
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
  let currentPrice = config.initialPrice

  // 启动时加载最近行情，若无则写入初始价格
  ctx.on('ready', async () => {
    const history = await ctx.database.get('bourse_history', { stockId }, { limit: 1, sort: { time: 'desc' } })
    if (history.length > 0) {
      currentPrice = history[0].price
    } else {
      await ctx.database.create('bourse_history', { stockId, price: currentPrice, time: new Date() })
    }
  })

  // 追踪市场开市状态，用于在开市时切换K线模型
  let wasMarketOpen = false

  // 市场定时任务（每 2 分钟运行一次）
  ctx.setInterval(async () => {
    const isOpen = await isMarketOpen()
    
    // 检测开市事件：从关闭变为开启
    if (isOpen && !wasMarketOpen) {
      // 开市了，切换K线模型
      switchKLinePattern('自动开市')
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
      const newValue = current + delta
      
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

      let remaining = amount
      for (const record of demandRecords) {
        if (remaining <= 0) break

        if (record.amount <= remaining) {
          remaining -= record.amount
          await ctx.database.remove('monetary_bank_int', { id: record.id })
        } else {
          await ctx.database.set('monetary_bank_int', { id: record.id }, { amount: record.amount - remaining })
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
      return { success: false, msg: `资金不足！需要 ${cost.toFixed(2)}，当前现金 ${cash} + 活期 ${bankDemand}` }
    }

    let remainingCost = cost
    
    // 1. 扣除现金
    const cashDeduct = Math.min(cash, remainingCost)
    if (cashDeduct > 0) {
      const success = await changeCashBalance(uid, currency, -cashDeduct)
      if (!success) return { success: false, msg: '扣除现金失败，请重试' }
      remainingCost -= cashDeduct
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
    const now = new Date()

    // 确保时间类型正确
    if (state) {
      if (!state.lastCycleStart) state.lastCycleStart = new Date(Date.now() - 7 * 24 * 3600 * 1000)
      if (!(state.lastCycleStart instanceof Date)) state.lastCycleStart = new Date(state.lastCycleStart)
      
      if (!state.endTime) state.endTime = new Date(state.lastCycleStart.getTime() + 7 * 24 * 3600 * 1000)
      if (!(state.endTime instanceof Date)) state.endTime = new Date(state.endTime)
    }

    // 优先处理手动配置
    if (config.enableManualControl) {
      // 如果当前不是手动模式，或者目标价格变动，或者状态不存在，则重置为配置的手动状态
      if (!state || state.mode !== 'manual' || Math.abs(state.targetPrice - config.manualTargetPrice) > 0.01) {
         const durationHours = config.manualDuration
         const targetPrice = config.manualTargetPrice
         const endTime = new Date(now.getTime() + durationHours * 3600 * 1000)
         const minutes = durationHours * 60
         const trendFactor = (targetPrice - currentPrice) / minutes

         const newState: BourseState = {
            key: 'macro_state',
            lastCycleStart: now,
            startPrice: currentPrice,
            targetPrice,
            trendFactor,
            mode: 'manual',
            endTime
         }
         if (!state) await ctx.database.create('bourse_state', newState)
         else {
           // 排除主键字段，只更新其他字段
           const { key, ...updateFields } = newState
           await ctx.database.set('bourse_state', { key: 'macro_state' }, updateFields)
         }
         state = newState
      }
    }

    // 状态初始化或过期检查 (仅在非强制手动模式下运行自动逻辑)
    let needNewState = false
    if (!config.enableManualControl) {
      if (!state) {
        needNewState = true
      } else {
        // 检查是否过期（一周周期）
        const endTime = state.endTime || new Date(state.lastCycleStart.getTime() + 7 * 24 * 3600 * 1000)
        if (now > endTime) {
          needNewState = true
        }
      }

      if (needNewState) {
        // 生成新的自动调控状态（一周周期）
        const durationHours = 7 * 24 // 一周 = 168 小时
        const fluctuation = 0.30 // 一周内最大30%波动
        const targetRatio = 1 + (Math.random() * 2 - 1) * fluctuation // 随机涨跌幅
        const targetPrice = currentPrice * targetRatio
        const endTime = new Date(now.getTime() + durationHours * 3600 * 1000)
        
        // 计算每分钟趋势
        const minutes = durationHours * 60
        const trendFactor = (targetPrice - currentPrice) / minutes

        const newState: BourseState = {
          key: 'macro_state',
          lastCycleStart: now,
          startPrice: currentPrice,
          targetPrice,
          trendFactor,
          mode: 'auto',
          endTime
        }

        if (!state) {
          await ctx.database.create('bourse_state', newState)
        } else {
          // 排除主键字段，只更新其他字段
          const { key, ...updateFields } = newState
          await ctx.database.set('bourse_state', { key: 'macro_state' }, updateFields)
        }
        state = newState
      }
    }

    // 检查是否需要随机时间切换K线模型
    const timeSinceLastSwitch = now.getTime() - lastPatternSwitchTime.getTime()
    // 强制切换阈值：30小时 (防止因某些原因卡死在旧模型)
    const forceSwitchDuration = 30 * 3600 * 1000
    
    if (now >= nextPatternSwitchTime || timeSinceLastSwitch > forceSwitchDuration) {
      switchKLinePattern('随机时间')
    }

    // 应用价格变化
    // 1. 宏观趋势项：根据周目标计算的线性趋势 (2分钟)
    const trend = state.trendFactor * 2
    
    // 2. 随机波动项：模拟市场噪音 (0.3% 波动)
    const volatility = currentPrice * 0.003 * (Math.random() * 2 - 1)

    // 3. 日内K线形态项：根据当天选中的K线模型计算价格偏移
    const dayStart = new Date(now)
    dayStart.setHours(config.openHour, 0, 0, 0)
    const dayEnd = new Date(now)
    dayEnd.setHours(config.closeHour, 0, 0, 0)
    const dayDuration = dayEnd.getTime() - dayStart.getTime()
    const dayElapsed = now.getTime() - dayStart.getTime()
    const dayProgress = Math.max(0, Math.min(1, dayElapsed / dayDuration))
    
    // 计算日内K线模型的价格偏移（相对于日内波动幅度）
    const dailyAmplitude = state.startPrice * 0.05 // 日内波动幅度约为5%
    const patternFn = kLinePatterns[currentDayPattern]
    
    // 计算当前和上一时刻的K线值差异
    const prevDayProgress = Math.max(0, (dayElapsed - 2 * 60 * 1000) / dayDuration)
    const patternDelta = (patternFn(dayProgress) - patternFn(prevDayProgress)) * dailyAmplitude

    // 4. 周内波浪项：一周内有多个波段
    const totalDuration = state.endTime.getTime() - state.lastCycleStart.getTime()
    const elapsed = now.getTime() - state.lastCycleStart.getTime()
    const prevElapsed = elapsed - 2 * 60 * 1000

    // 周波浪参数：一周内约7个波段（每天一个大致方向）
    const waveCount = 7
    const weeklyAmplitude = state.startPrice * 0.08 // 周波浪幅度8%

    const getWaveValue = (t: number) => {
        const progress = t / totalDuration
        // 复合波形：主波 + 次波
        return weeklyAmplitude * (
          Math.sin(2 * Math.PI * waveCount * progress) * 0.7 +
          Math.sin(2 * Math.PI * waveCount * 2.5 * progress) * 0.3
        )
    }

    const waveDelta = getWaveValue(elapsed) - getWaveValue(prevElapsed)
    
    let newPrice = currentPrice + trend + volatility + patternDelta + waveDelta
    if (newPrice < 1) newPrice = 1 // 最低价格保护

    currentPrice = newPrice
    await ctx.database.create('bourse_history', { stockId, price: newPrice, time: new Date() })
    
    // 清理过旧历史（保留3天）
    // await ctx.database.remove('bourse_history', { time: { $lt: new Date(now.getTime() - 3 * 24 * 3600 * 1000) } })
  }

  // --- 交易处理逻辑 ---

  async function processPendingTransactions() {
    const now = new Date()
    const pending = await ctx.database.get('bourse_pending', { endTime: { $lte: now } })

    for (const txn of pending) {
      if (txn.type === 'buy') {
        // 买入解冻：增加持仓
        const holding = await ctx.database.get('bourse_holding', { userId: txn.userId, stockId })
        if (holding.length === 0) {
          await ctx.database.create('bourse_holding', { userId: txn.userId, stockId, amount: txn.amount })
        } else {
          await ctx.database.set('bourse_holding', { userId: txn.userId, stockId }, { amount: holding[0].amount + txn.amount })
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
      
      const title = config.stockName + (interval === 'week' ? ' (周走势)' : interval === 'day' ? ' (日走势)' : ' (实时)')
      
      const img = await renderStockImage(ctx, formattedData, title, latest.price, high, low)
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
      let freezeMinutes = cost / config.freezeCostPerMinute
      if (freezeMinutes < config.minFreezeTime) freezeMinutes = config.minFreezeTime
      if (freezeMinutes > config.maxFreezeTime) freezeMinutes = config.maxFreezeTime
      const freezeMs = freezeMinutes * 60 * 1000
      const endTime = new Date(Date.now() + freezeMs)

      await ctx.database.create('bourse_pending', {
        userId: visibleUserId,
        uid,
        stockId,
        type: 'buy',
        amount,
        price: currentPrice,
        cost,
        startTime: new Date(),
        endTime
      })

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

      // 立即扣减持仓
      const newAmount = holding[0].amount - amount
      if (newAmount === 0) {
        await ctx.database.remove('bourse_holding', { userId: visibleUserId, stockId })
      } else {
        await ctx.database.set('bourse_holding', { userId: visibleUserId, stockId }, { amount: newAmount })
      }

      // 计算收益
      const gain = Number((currentPrice * amount).toFixed(2))
      // 计算冻结时间（按交易金额计算）
      let freezeMinutes = gain / config.freezeCostPerMinute
      if (freezeMinutes < config.minFreezeTime) freezeMinutes = config.minFreezeTime
      if (freezeMinutes > config.maxFreezeTime) freezeMinutes = config.maxFreezeTime
      const freezeMs = freezeMinutes * 60 * 1000
      const endTime = new Date(Date.now() + freezeMs)

      await ctx.database.create('bourse_pending', {
        userId: visibleUserId,
        uid,
        stockId,
        type: 'sell',
        amount,
        price: currentPrice,
        cost: gain,
        startTime: new Date(),
        endTime
      })

      return `卖出挂单已提交！\n预计收益: ${gain.toFixed(2)} ${config.currency}\n资金冻结: ${freezeMinutes.toFixed(1)}分钟\n资金将在解冻后到账。`
    })

  ctx.command('stock.my', '我的持仓')
    .action(async ({ session }) => {
      const userId = session.userId
      const holdings = await ctx.database.get('bourse_holding', { userId })
      const pending = await ctx.database.get('bourse_pending', { userId })

      let msg = `=== ${session.username} 的股票账户 ===\n`
      
      if (holdings.length > 0) {
        const h = holdings[0]
        const value = h.amount * currentPrice
        msg += `持仓: ${config.stockName} x${h.amount} 股\n`
        msg += `当前市值: ${value.toFixed(2)} ${config.currency}\n`
      } else {
        msg += `持仓: 无\n`
      }

      if (pending.length > 0) {
        msg += `\n--- 进行中的交易 ---\n`
        for (const p of pending) {
          const timeLeft = Math.max(0, Math.ceil((p.endTime.getTime() - Date.now()) / 1000))
          const typeStr = p.type === 'buy' ? '买入' : '卖出'
          msg += `[${typeStr}] ${p.amount}股 | 剩余冻结: ${timeLeft}秒\n`
        }
      }

      return msg
    })

  ctx.command('stock.control <price:number> [hours:number]', '管理员：设置宏观调控目标', { authority: 3 })
    .action(async ({ session }, price, hours) => {
      if (!price || price <= 0) return '请输入有效的目标价格。'
      const duration = hours || 24 // 默认24小时
      
      const now = new Date()
      const endTime = new Date(now.getTime() + duration * 3600 * 1000)
      
      // 计算趋势
      const minutes = duration * 60
      const trendFactor = (price - currentPrice) / minutes
      
      const newState: BourseState = {
        key: 'macro_state',
        lastCycleStart: now,
        startPrice: currentPrice,
        targetPrice: price,
        trendFactor,
        mode: 'manual',
        endTime
      }
      
      // 写入数据库
      const existing = await ctx.database.get('bourse_state', { key: 'macro_state' })
      if (existing.length === 0) {
        await ctx.database.create('bourse_state', newState)
      } else {
        await ctx.database.set('bourse_state', 'macro_state', newState)
      }
      
      // 立即触发一次更新以应用新状态（可选，这里仅更新状态）
      return `宏观调控已设置：\n目标价格：${price}\n期限：${duration}小时\n模式：手动干预\n到期后将自动切回随机调控。`
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

  // --- 渲染逻辑 ---
  
  async function renderStockImage(ctx: Context, data: {time: string, price: number, timestamp: number}[], name: string, current: number, high: number, low: number) {
    if (data.length < 2) return '数据不足，无法绘制走势图。'
    
    const startPrice = data[0].price
    const change = current - startPrice
    const changePercent = (change / startPrice) * 100
    const isUp = change >= 0
    const color = isUp ? '#d93025' : '#188038'
    
    const points = JSON.stringify(data.map(d => d.price))
    const times = JSON.stringify(data.map(d => d.time))
    const timestamps = JSON.stringify(data.map(d => d.timestamp))
    
    const html = `
    <html>
    <head>
      <style>
        body { margin: 0; padding: 20px; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f5f7fa; width: 700px; box-sizing: border-box; }
        .card { background: white; padding: 25px; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
        .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
        .title-group { display: flex; flex-direction: column; }
        .title { font-size: 28px; font-weight: 800; color: #1a1a1a; letter-spacing: -0.5px; }
        .sub-info { font-size: 14px; color: #888; margin-top: 5px; font-weight: 500; }
        .price-group { text-align: right; }
        .price { font-size: 42px; font-weight: 800; color: ${color}; letter-spacing: -1px; line-height: 1; }
        .change { font-size: 18px; font-weight: 600; color: ${color}; margin-top: 5px; display: flex; align-items: center; justify-content: flex-end; gap: 5px; }
        .badge { background: #f0f2f5; padding: 4px 8px; border-radius: 6px; font-size: 12px; color: #555; font-weight: 600; }
        canvas { width: 100%; height: 350px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <div class="title-group">
            <div class="title">${name}</div>
            <div class="sub-info">
              <span class="badge">High: ${high.toFixed(2)}</span>
              <span class="badge">Low: ${low.toFixed(2)}</span>
            </div>
          </div>
          <div class="price-group">
            <div class="price">${current.toFixed(2)}</div>
            <div class="change">
              <span>${change >= 0 ? '+' : ''}${change.toFixed(2)}</span>
              <span>(${changePercent.toFixed(2)}%)</span>
            </div>
          </div>
        </div>
        <canvas id="chart" width="1300" height="700"></canvas>
      </div>
      <script>
        const canvas = document.getElementById('chart');
        const ctx = canvas.getContext('2d');
        const prices = ${points};
        const times = ${times};
        const timestamps = ${timestamps};
        const width = canvas.width;
        const height = canvas.height;
        const padding = { top: 20, bottom: 40, left: 40, right: 100 };
        
        const max = Math.max(...prices);
        const min = Math.min(...prices);
        const range = max - min || 1;
        const yMin = min - range * 0.1;
        const yMax = max + range * 0.1;
        const yRange = yMax - yMin;

        const minTime = timestamps[0];
        const maxTime = timestamps[timestamps.length - 1];
        const timeRange = maxTime - minTime || 1;

        function getX(t) { return ((t - minTime) / timeRange) * (width - padding.left - padding.right) + padding.left; }
        function getY(p) { return height - padding.bottom - ((p - yMin) / yRange) * (height - padding.top - padding.bottom); }
        
        // 1. Draw Grid
        ctx.strokeStyle = '#f0f0f0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const gridSteps = 5;
        for (let i = 0; i <= gridSteps; i++) {
            const y = height - padding.bottom - (i / gridSteps) * (height - padding.top - padding.bottom);
            ctx.moveTo(padding.left, y);
            ctx.lineTo(width - padding.right, y);
        }
        ctx.stroke();

        // 2. Draw Area (Gradient Fill)
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, '${isUp ? 'rgba(217, 48, 37, 0.15)' : 'rgba(24, 128, 56, 0.15)'}');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

        ctx.beginPath();
        ctx.moveTo(getX(timestamps[0]), height - padding.bottom);
        // Use Bezier curves for smoothing
        for (let i = 0; i < prices.length - 1; i++) {
            const x = getX(timestamps[i]);
            const y = getY(prices[i]);
            const nextX = getX(timestamps[i + 1]);
            const nextY = getY(prices[i + 1]);
            const cpX = (x + nextX) / 2;
            if (i === 0) ctx.moveTo(x, y);
            ctx.quadraticCurveTo(x, y, cpX, (y + nextY) / 2);
        }
        // Connect to last point
        ctx.lineTo(getX(timestamps[prices.length - 1]), getY(prices[prices.length - 1]));
        
        // Close path for fill
        ctx.lineTo(getX(timestamps[prices.length - 1]), height - padding.bottom);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // 3. Draw Line (Smooth)
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = '${color}';
        ctx.shadowColor = '${isUp ? 'rgba(217, 48, 37, 0.3)' : 'rgba(24, 128, 56, 0.3)'}';
        ctx.shadowBlur = 10;
        
        ctx.beginPath();
        for (let i = 0; i < prices.length - 1; i++) {
            const x = getX(timestamps[i]);
            const y = getY(prices[i]);
            const nextX = getX(timestamps[i + 1]);
            const nextY = getY(prices[i + 1]);
            const cpX = (x + nextX) / 2;
            if (i === 0) ctx.moveTo(x, y);
            // Use quadratic curve for simple smoothing between points
            // Actually, to pass through points, we need a different approach or just straight lines for accuracy.
            // But for "beautify", slight smoothing is okay. 
            // A simple smoothing is to use midpoints as control points.
            // Let's stick to straight lines for accuracy but add shadow/glow.
            // Or use a simple spline.
            // Let's revert to straight lines for financial accuracy but keep the glow.
            ctx.lineTo(nextX, nextY);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 4. Draw Last Point Marker
        const lastX = getX(timestamps[prices.length - 1]);
        const lastY = getY(prices[prices.length - 1]);
        
        ctx.beginPath();
        ctx.arc(lastX, lastY, 6, 0, Math.PI * 2);
        ctx.fillStyle = 'white';
        ctx.fill();
        
        ctx.beginPath();
        ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
        ctx.fillStyle = '${color}';
        ctx.fill();

        // 5. Draw Dashed Line to Y-Axis
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1;
        ctx.moveTo(padding.left, lastY);
        ctx.lineTo(width - padding.right, lastY);
        ctx.stroke();
        ctx.setLineDash([]);

        // 6. Draw Axis Labels
        ctx.fillStyle = '#999';
        ctx.font = '600 20px "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        for (let i = 0; i <= gridSteps; i++) {
            const val = yMin + (i / gridSteps) * yRange;
            const y = height - padding.bottom - (i / gridSteps) * (height - padding.top - padding.bottom);
            ctx.fillText(val.toFixed(2), width - padding.right + 10, y);
        }
        
        ctx.fillStyle = '${color}';
        ctx.font = 'bold 20px "Segoe UI", sans-serif';
        ctx.fillText(prices[prices.length-1].toFixed(2), width - padding.right + 10, lastY);

        ctx.textAlign = 'center';
        ctx.fillStyle = '#999';
        ctx.font = '500 18px "Segoe UI", sans-serif';
        
        // 动态计算标签间隔，防止重叠
        // 使用最长的时间标签来估算宽度
        let maxLabelWidth = 0;
        for (let i = 0; i < times.length; i++) {
            const w = ctx.measureText(times[i]).width;
            if (w > maxLabelWidth) maxLabelWidth = w;
        }
        const labelWidth = maxLabelWidth + 40; // 加40px间距确保不重叠
        const availableWidth = width - padding.left - padding.right;
        const maxLabels = Math.max(2, Math.floor(availableWidth / labelWidth));
        const labelCount = Math.min(maxLabels, 5); // 最多显示5个标签
        const timeStep = Math.max(1, Math.ceil(times.length / labelCount));
        
        // 选取要绘制的标签索引（均匀分布）
        const labelIndices = [];
        for (let i = 0; i < times.length; i += timeStep) {
           labelIndices.push(i);
        }
        // 确保最后一个点在列表中
        if (labelIndices[labelIndices.length - 1] !== times.length - 1) {
           labelIndices.push(times.length - 1);
        }
        
        // 绘制标签，跳过重叠的
        const drawnLabels = [];
        for (const i of labelIndices) {
           const x = getX(timestamps[i]);
           const textWidth = ctx.measureText(times[i]).width;
           
           // 根据textAlign计算实际占用的区域
           let leftEdge, rightEdge;
           if (i === 0) {
               leftEdge = x;
               rightEdge = x + textWidth;
           } else if (i === times.length - 1) {
               leftEdge = x - textWidth;
               rightEdge = x;
           } else {
               leftEdge = x - textWidth / 2;
               rightEdge = x + textWidth / 2;
           }
           
           // 检查是否与已绘制的标签重叠
           let overlaps = false;
           for (const drawn of drawnLabels) {
               // 两个标签之间至少要有15px间隔
               if (!(rightEdge + 15 < drawn.left || leftEdge - 15 > drawn.right)) {
                   overlaps = true;
                   break;
               }
           }
           if (overlaps) continue;
           
           if (i === 0) ctx.textAlign = 'left';
           else if (i === times.length - 1) ctx.textAlign = 'right';
           else ctx.textAlign = 'center';
           
           ctx.fillText(times[i], x, height - 10);
           drawnLabels.push({ left: leftEdge, right: rightEdge });
        }

      </script>
    </body>
    </html>
    `

    const page = await ctx.puppeteer.page()
    await page.setContent(html)
    const element = await page.$('.card') // Capture only the card element
    const imgBuf = await element?.screenshot({ encoding: 'binary' })
    await page.close()
    
    return h.image(imgBuf, 'image/png')
  }
}
