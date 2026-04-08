# Agent Manager

> 自动拆分任务、智能选模型、控制成本的 AI 编排层。

你只需要描述任务，Agent Manager 自动决定用哪个模型、花多少钱。简单的子任务用便宜模型，复杂的子任务用好模型，最终汇总结果返回给你。

兼容 Claude Code、OpenClaw 及任何能发 HTTP 请求的 AI 客户端。

---

## 它解决什么问题

当你让 AI 处理一个复杂任务时，背后其实有很多难度不同的子步骤。比如"分析这段代码并修复 bug"：

- 理解代码结构 → 简单，便宜模型够用
- 分析问题根因 → 中等难度
- 生成修复方案 → 复杂，需要好模型
- 验证结果正确性 → 高精度要求

如果全部打到 GPT-4o 或 Claude Opus，成本很高。如果全用便宜模型，质量下降。

Agent Manager 自动完成这个分配：**每个子任务用最合适的模型，不多花一分钱。**

---

## 快速开始

### 安装

```bash
git clone https://github.com/NoNightWatch/agent-manager-for-ai-planner.git
cd agent-manager-for-ai-planner
npm install
npm run build
```

### 零配置体验

不需要任何 API key，直接用 mock provider 跑通完整流程：

```bash
npx tsx src/cli.ts "写一个冒泡排序的 Python 实现"
```

输出：
```
✓ Plan: 1 task (single_executor)
  ✓ single_executor → mock   [cheap]   $0.0000
─────────────────────────────────────
Result:
{ "status": "ok", ... }

Total: $0.0000 | 0.8s
```

### 配置真实 API key

复制配置文件：
```bash
cp .env.example .env
```

在 `.env` 里填入 API key（至少一个）：
```
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-xxx
```

运行：
```bash
npx tsx src/cli.ts "分析这段代码有什么性能问题" --provider anthropic
```

输出：
```
✓ Plan: 3 tasks (triage + executor + verifier)
  ✓ triage    → anthropic/claude-3-haiku    [cheap]     $0.0001
  ✓ executor  → anthropic/claude-3-5-sonnet [standard]  $0.0008
  ✓ verifier  → anthropic/claude-3-opus     [premium]   $0.0031
──────────────────────────────────────────────────────────────
Result:
该函数在循环内部重复调用 Array.indexOf()，时间复杂度为 O(n²)...

Total: $0.0040 | 5.8s
```

### CLI 参数

```bash
npx tsx src/cli.ts "任务描述" [选项]

  --budget    cheap | normal | thorough   预算等级（默认 normal）
  --provider  anthropic | openai | mock   使用的 provider
  --timeout   毫秒数                      超时时间（默认 30000）
```

---

## 工作原理

```
用户输入一句话描述
        ↓
Planner 自动拆分成多个 agent 任务
        ↓
每个任务按角色和复杂度确定 tier
  cheap / standard / premium
        ↓
从 OpenRouter 公开接口拉取 321+ 个模型的实时价格
在 tier 内选性价比最高的模型（top_provider 优先）
        ↓
调用你配置的 API（Anthropic / OpenAI）执行
        ↓
汇总结果 + 成本明细返回
```

### 模型分层逻辑

| Agent 角色 | 默认 Tier | 说明 |
|-----------|-----------|------|
| triage | cheap | 理解和分类任务 |
| executor | cheap → premium | 根据 reasoning_level 自动上调 |
| verifier | premium | 验证结果需要最高精度 |
| planner | standard | 生成执行计划 |

### Tier 对应价格区间（$/1M tokens）

| Tier | 价格区间 | 典型模型 |
|------|---------|---------|
| cheap | < $1 | Claude Haiku、Mistral 7B、Llama 3.1 8B |
| standard | $1 – $5 | Claude Sonnet、GPT-4o-mini、Llama 70B |
| premium | > $5 | Claude Opus、GPT-4o、Gemini Pro |

价格每小时从 [OpenRouter](https://openrouter.ai/api/v1/models) 自动刷新，无需 API key。

---

## 作为 HTTP 服务接入

启动服务：
```bash
npm start   # 默认 port 3000
```

### 推荐：异步接口

```bash
# 1. 提交任务
curl -X POST http://localhost:3000/v1/run \
  -H "Content-Type: application/json" \
  -H "X-Run-Token: your-token" \
  -d '{"user_request": "写一个快速排序算法", "options": {"budget_level": "normal"}}'
# → { "run_id": "run_abc123", "status": "queued" }

# 2. 查询结果
curl http://localhost:3000/v1/run/run_abc123 \
  -H "X-Run-Token: your-token"

# 或实时监听事件流
curl http://localhost:3000/v1/run/run_abc123/stream \
  -H "X-Run-Token: your-token"
```

### 同步接口（适合低延迟本地环境）

```bash
curl -X POST "http://localhost:3000/v1/run/sync?timeout_ms=60000" \
  -H "Content-Type: application/json" \
  -H "X-Run-Token: your-token" \
  -d '{"user_request": "写一个快速排序算法", "options": {"budget_level": "normal"}}' \
  --max-time 120
```

> **Windows 用户注意：** 建议使用异步接口，sync 接口在 Windows 的 TCP 实现下可能出现连接时序问题。

### 自己提供 Plan

如果你想完全控制任务拆分，可以绕过自动规划直接提供 plan：

```bash
curl -X POST http://localhost:3000/v1/run \
  -H "Content-Type: application/json" \
  -H "X-Run-Token: your-token" \
  -d '{
    "plan": {
      "mode": "single",
      "tasks": [{
        "name": "executor",
        "agent": "executor",
        "input": "写一个冒泡排序",
        "reasoning_level": "low"
      }]
    }
  }'
```

---

## 与 Claude Code 集成

在 Claude Code 会话中，直接告诉它调用你的服务：

```
我本地有一个 Agent Manager 服务运行在 http://localhost:3000

请用它来完成任务，调用方式：
POST http://localhost:3000/v1/run
Headers: Content-Type: application/json, X-Run-Token: your-token
Body: {"user_request": "你的任务描述", "options": {"budget_level": "normal"}}

任务：分析这个函数的时间复杂度
```

Claude Code 会自动调用你的服务，Agent Manager 处理任务拆分和模型选择，结果返回给 Claude Code 继续使用。

---

## 环境变量

完整配置见 [.env.example](.env.example)。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `DEFAULT_PROVIDER_ID` | `mock` | 默认 provider，不配置 key 时用 mock |
| `OUTBOUND_ALLOWLIST` | `openrouter.ai` | 允许的出站域名 |
| `REQUIRE_RUN_TOKEN` | `0` | 设为 `1` 开启 token 验证 |
| `PORT` | `3000` | HTTP 服务端口 |
| `PERSIST_RUNS` | `0` | 设为 `1` 将运行记录持久化到 `./runs` |

**使用真实 provider 时需要把对应域名加入白名单：**
```
# Anthropic
OUTBOUND_ALLOWLIST=openrouter.ai,api.anthropic.com

# OpenAI
OUTBOUND_ALLOWLIST=openrouter.ai,api.openai.com
```

---

## 项目结构

```
src/
├── cli.ts                    # 命令行入口
├── server.ts                 # HTTP 服务入口
├── app.ts                    # Express 路由
├── config.ts                 # 环境变量配置
├── types.ts                  # 类型定义
├── services/
│   ├── runner.ts             # 统一调用入口
│   ├── planner.ts            # 任务拆分
│   ├── planner-strategies.ts # 规划策略
│   ├── model-tier.ts         # Tier 选择逻辑
│   ├── openrouter-pricing.ts # 实时价格缓存
│   ├── engine.ts             # 执行引擎
│   └── orchestrator.ts       # 编排调度
├── providers/
│   ├── anthropic.ts          # Anthropic provider
│   ├── openai.ts             # OpenAI provider
│   ├── mock.ts               # Mock provider
│   └── model-id-map.ts       # OpenRouter ID 映射表
└── config/
    └── pricing-tiers.ts      # Tier 阈值配置
```

---

## 开发

```bash
npm test          # 运行全部测试（66 个）
npm run build     # 编译 TypeScript
npm run dev       # 开发模式（热重载）
npm start         # 生产模式
```

---

## 支持的模型

通过 OpenRouter 价格接口自动发现 321+ 个模型，包括：

- **Anthropic**：Claude Haiku / Sonnet / Opus 系列
- **OpenAI**：GPT-4o / GPT-4o-mini / GPT-3.5-turbo
- **Meta**：Llama 3.1 8B / 70B / 405B
- **Mistral**：Mistral 7B / Small / Large / Mixtral
- **Google**：Gemini Flash / Pro 系列
- **DeepSeek**：DeepSeek V2 / V3

---

## License

MIT
