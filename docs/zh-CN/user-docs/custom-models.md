# 自定义模型

通过 `~/.gsd/agent/models.json` 添加自定义 providers 和 models（Ollama、vLLM、LM Studio、代理等）。

## 目录

- [最小示例](#minimal-example)
- [完整示例](#full-example)
- [支持的 API](#supported-apis)
- [Provider 配置](#provider-configuration)
- [Model 配置](#model-configuration)
- [覆盖内置 Providers](#overriding-built-in-providers)
- [按 model 覆盖](#per-model-overrides)
- [更新 Model 目录](#updating-the-model-catalog)
- [OpenAI 兼容性](#openai-compatibility)

<a id="minimal-example"></a>
## 最小示例

对于本地 models（Ollama、LM Studio、vLLM），每个 model 只要求提供 `id`：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

`apiKey` 在 schema 中是必填，但 Ollama 会忽略它，因此任意值都可以。

有些 OpenAI-compatible server 不支持推理模型使用的 `developer` role。对于这类 provider，需要把 `compat.supportsDeveloperRole` 设为 `false`，这样 GSD 会改用 `system` message 发送 system prompt。如果该 server 同时也不支持 `reasoning_effort`，还应把 `compat.supportsReasoningEffort` 也设为 `false`。

你可以在 provider 级别设置 `compat`，让它应用到该 provider 下的所有 models；也可以在 model 级别单独覆盖某个 model。这个设置常见于 Ollama、vLLM、SGLang 以及类似的 OpenAI-compatible server。

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "gpt-oss:20b",
          "reasoning": true
        }
      ]
    }
  }
}
```

<a id="full-example"></a>
## 完整示例

当你需要显式覆盖默认值时，可以写成更完整的配置：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B (Local)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

每次打开 `/model` 时，这个文件都会重新加载。可以在会话过程中直接编辑，无需重启。

<a id="supported-apis"></a>
## 支持的 API

| API | 说明 |
|-----|------|
| `openai-completions` | OpenAI Chat Completions（兼容性最好） |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

`api` 可以设置在 provider 级别（作为该 provider 下所有 models 的默认值），也可以设置在 model 级别（覆盖单个 model）。

<a id="provider-configuration"></a>
## Provider 配置

| 字段 | 说明 |
|------|------|
| `baseUrl` | API endpoint URL |
| `api` | API 类型（见上） |
| `apiKey` | API key（见下方值解析） |
| `headers` | 自定义请求头（见下方值解析） |
| `authHeader` | 设为 `true` 时，自动添加 `Authorization: Bearer <apiKey>` |
| `models` | model 配置数组 |
| `modelOverrides` | 针对该 provider 的内置 models 做按 model 覆盖 |

<a id="value-resolution"></a>
### 值解析

`apiKey` 和 `headers` 支持三种写法：

- **Shell 命令：** `"!command"`，执行后读取 stdout
  ```json
  "apiKey": "!security find-generic-password -ws 'anthropic'"
  "apiKey": "!op read 'op://vault/item/credential'"
  ```
- **环境变量：** 取对应环境变量的值
  ```json
  "apiKey": "MY_API_KEY"
  ```
- **字面量：** 直接使用
  ```json
  "apiKey": "sk-..."
  ```

<a id="command-allowlist"></a>
#### 命令允许列表

Shell 命令（`!command`）只能执行一组已知的凭据工具。只有以下前缀开头的命令才会被允许：

`pass`、`op`、`aws`、`gcloud`、`vault`、`security`、`gpg`、`bw`、`gopass`、`lpass`

不在列表中的命令会被阻止，最终该值会解析为 `undefined`。同时会向 stderr 输出一条警告。

为了防止注入，命令参数中的 shell 操作符（`;`、`|`、`&`、`` ` ``、`$`、`>`、`<`）同样会被阻止。

**自定义允许列表：**

如果你使用的凭据工具不在默认列表中，可以在全局设置（`~/.gsd/agent/settings.json`）里覆盖：

```json
{
  "allowedCommandPrefixes": ["pass", "op", "sops", "doppler", "mycli"]
}
```

这会完全替换默认列表，因此如果你还想保留默认命令，需要一起写进去。

你也可以设置 `GSD_ALLOWED_COMMAND_PREFIXES` 环境变量（逗号分隔）。环境变量优先级高于 settings.json：

```bash
export GSD_ALLOWED_COMMAND_PREFIXES="pass,op,sops,doppler"
```

> **注意：** 这是一个仅全局生效的设置。项目级 settings.json（`<project>/.gsd/settings.json`）不能覆盖命令 allowlist，以防克隆下来的仓库提升命令执行权限。

### 自定义 Headers

```json
{
  "providers": {
    "custom-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "MY_API_KEY",
      "api": "anthropic-messages",
      "headers": {
        "x-portkey-api-key": "PORTKEY_API_KEY",
        "x-secret": "!op read 'op://vault/item/secret'"
      },
      "models": [...]
    }
  }
}
```

<a id="model-configuration"></a>
## Model 配置

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | 是 | — | Model 标识符（会原样传给 API） |
| `name` | 否 | `id` | 可读的 model 标签，用于匹配（例如 `--model` 模糊匹配）并显示在详情 / 状态文字里 |
| `api` | 否 | provider 的 `api` | 为这个 model 覆盖 provider 的 API 类型 |
| `reasoning` | 否 | `false` | 是否支持扩展 thinking |
| `input` | 否 | `["text"]` | 输入类型：`["text"]` 或 `["text", "image"]` |
| `contextWindow` | 否 | `128000` | 上下文窗口大小（tokens） |
| `maxTokens` | 否 | `16384` | 最大输出 tokens |
| `cost` | 否 | 全为 0 | `{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}`（每百万 tokens） |
| `compat` | 否 | provider 的 `compat` | OpenAI 兼容性覆盖项。如果 provider 和 model 两边都配置了，会合并 |

当前行为：

- `/model` 与 `--list-models` 都是按 model `id` 列出条目
- 配置里的 `name` 会用于 model 匹配，以及详情 / 状态文本展示

<a id="overriding-built-in-providers"></a>
## 覆盖内置 Providers

如果你想把某个内置 provider 经由代理路由出去，但又不想重新定义全部 models，可以这样写：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1"
    }
  }
}
```

这样所有内置 Anthropic models 仍然可用。已有的 OAuth 或 API key 认证也会继续生效。

如果你想把自定义 models 合并进某个内置 provider，就同时提供 `models` 数组：

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://my-proxy.example.com/v1",
      "apiKey": "ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "models": [...]
    }
  }
}
```

合并规则如下：

- 内置 models 会保留
- 自定义 models 会按 `id` 在该 provider 下执行 upsert
- 如果某个自定义 model 的 `id` 与内置 model 相同，自定义 model 会替换那个内置 model
- 如果某个自定义 model 的 `id` 是新的，它会作为新增条目并列出现

<a id="per-model-overrides"></a>
## 按 model 覆盖

如果你只想修改某些特定的内置 model，而不想替换整个 provider 的 model 列表，可以使用 `modelOverrides`。

```json
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "anthropic/claude-sonnet-4": {
          "name": "Claude Sonnet 4 (Bedrock Route)",
          "compat": {
            "openRouterRouting": {
              "only": ["amazon-bedrock"]
            }
          }
        }
      }
    }
  }
}
```

`modelOverrides` 支持的字段包括：`name`、`reasoning`、`input`、`cost`（可部分覆盖）、`contextWindow`、`maxTokens`、`headers`、`compat`。

行为说明：

- `modelOverrides` 只会应用到内置 provider 的 models 上
- 未知的 model ID 会被忽略
- 可以把 provider 级别的 `baseUrl` / `headers` 与 `modelOverrides` 组合使用
- 如果某个 provider 同时定义了 `models`，那么自定义 models 会在应用完内置覆盖后再合并；如果它的 `id` 与已覆盖的内置 model 相同，最终会以自定义 model 为准

<a id="updating-the-model-catalog"></a>
## 更新 Model 目录

在 shell 中运行 `gsd update --models`，或在 GSD 会话中运行 `/gsd update --models`，即可在不进行完整 npm 升级的情况下获取最新发布的 model 目录：

```bash
gsd update --models
# 在正在运行的 GSD 会话中：
/gsd update --models
```

该命令会从 gsd-pi 仓库的 `main` 分支下载当前生成的目录快照，并将其存储为一个带版本号的 JSON 覆盖文件，位于 `~/.gsd/agent/models-catalog.json`。获取过程无需认证，只使用已发布的全 provider 目录，超时时间为 15 秒。该参数是独立的；如果附加值，命令会在发起请求前拒绝执行。`/gsd upgrade --models` 是会话内命令的别名。

启动时，models 按以下优先级解析（从低到高）：

1. **内置目录**：随所安装的 GSD 版本一同提供。
2. **覆盖文件**：来自 `~/.gsd/agent/models-catalog.json`——会用相同 provider + model `id` 的条目替换内置条目，并新增 models 和 providers。
3. **`models.json`**（本文件）——自定义 providers、自定义 models 和 `modelOverrides` 始终具有最高优先级，且更新过程永远不会修改它。

这样就能在不升级 GSD 本身的情况下，随着新 model、定价和上下文窗口更新的发布而获得它们。会话内命令成功后会重新加载 model registry，因此新目录会立即生效，无需重启。只有在完整目录通过校验之后，覆盖文件才会被原子替换，因此下载、HTTP、校验或写入失败都不会影响现有的覆盖文件。如果覆盖文件缺失或格式错误，会被忽略，启动过程会继续使用内置目录和 `models.json`。

## GitHub Copilot 实时目录同步

除了 `gsd update --models` 之外，GitHub Copilot 现在还有一套独立的实时目录（live-catalog）工作流程。

旧的工作流程：

1. GitHub Copilot 上线或变更了某个 model。
2. 下一次发布的内置/生成目录最终会获知这一变化。
3. `gsd update --models` 或未来的 GSD 版本会将其纳入生效的本地目录。

新的工作流程：

1. `/gsd copilot-models sync` 会获取当前已认证账号的实时 Copilot `/models` 目录。
2. 响应会被规范化为一个不含密钥的本地快照，并具备“最后已知良好状态”保护。
3. `/gsd copilot-models changes`、`pricing`、`promos`、`doctor` 和 `why` 都会在本地检查该已接受的快照。
4. `/gsd copilot-models sync --register` 可以立即将**完整的**、仅存在于远端的 GitHub Copilot models 添加到 `~/.gsd/agent/models-catalog.json`，无需等待内置目录的发布更新。

注册 model 会立即重新加载内存中的 model registry，因此新注册的 model 在同一会话中即可通过 `/gsd model` 选中（也可用于 `tier_models` 固定配置）——无需重启。

该工作流程有意做成以 extension 优先、且仅针对特定 provider：

- 非 Copilot provider 不会产生 Copilot 的网络请求；
- 一旦已存在被接受的快照，`why`、`changes`、`pricing`、`promos` 和 `doctor` 就不需要再发起新的网络请求；
- models 永远不会因为一次可疑或失败的同步而被自动注册。

### 生效本地目录的优先级

对于 GitHub Copilot，生效的本地目录仍然遵循与其他所有 provider 相同的优先级顺序：

1. **内置目录**：随所安装的 GSD 版本一同提供。
2. **覆盖文件**：来自 `~/.gsd/agent/models-catalog.json`。
3. **`models.json`**：用户覆盖配置和自定义 models。

这意味着 `/gsd copilot-models sync` 默认只是观察性的，而 `sync --register` 只会写入 `gsd update --models` 已经在使用的同一层覆盖文件。它永远不会编辑 `models.json`，不会重写用户的覆盖配置，也不会影响无关的 provider。

### 完整 model 与隔离（quarantined）model

仅存在于远端的 Copilot models，会在任何写入操作发生之前先被分类。

- **完整（Complete）**：远端 provider 的响应，加上现有的 provider 静态兼容性数据，两者共同证明了一个可用的运行时 API / endpoint 映射、工具调用（tool-call）支持、上下文/输出限制，以及具备 provider 感知能力的 token 定价。这些 models 可以被安全地注册进本地覆盖文件。
- **隔离（Quarantined）**：只要存在缺失、冲突、预览版被禁用、策略被阻止，或可疑的元数据，该 model 就会被排除在生效的本地目录之外。该 model 仍然会在 `changes`、`doctor` 和 `why` 中可见，并附带具体的阻塞原因。

被隔离的 models 不会被写入带有虚构的零定价、虚构的限制或猜测协议的占位条目——这是有意为之的设计。

### provider 感知的定价优先级

Copilot 的定价按 provider + model 身份进行解析，优先级如下：

1. 来自 `models.json` 的明确用户覆盖（完整的自定义 model 定义，或针对 `github-copilot` 的 `modelOverrides` 条目）；
2. 来自已接受的 Copilot 快照的最新 provider 实时定价；
3. 来自当前内置 GitHub Copilot 目录条目的 provider 静态定价；
4. 未知。

Copilot 有意不使用通用的跨 provider 内置回退定价档位：共享的内置成本表仅按裸 model ID 建立索引，因此一个复用了其他 provider ID 的 Copilot model（例如 `gpt-5.5`）原本可能会悄悄地报告出那个其他 provider 的价格。未匹配的 models 会报告为 `unknown` 定价，而不是一个可能有误的猜测值。

`/gsd copilot-models pricing` 和 `/gsd copilot-models why <model>` 会同时显示解析出的值及其来源/新鲜度。未知值会保持为 `unknown`；它们永远不会被悄悄改写为 `$0.0000`。

请求倍率（multiplier）和促销信息会与 token 定价分开跟踪。促销信息属于生命周期元数据，而不是对已生效的实时价格进行二次折扣的指令。

### 路由置信度安全性

实时发现 Copilot models 并**不**意味着每一个新 model 都会被自动路由。

- 未分析或置信度未知的 models 默认仍然只能手动选择。
- 预览版和策略受限状态只是 `why` 报告的一个提示性警告，路由器本身并不强制执行——路由器的自动路由门槛仅基于能力置信度。一个已具备本地能力画像的预览版或策略受限 model 仍然可能被自动选中；请把预览/策略提示当作警告，而不是路由保证。
- 错误 provider 的 model ID 会在触发任何认证或网络路径之前，由 `why` 在本地拒绝。

`/gsd copilot-models why <model>` 会报告某个 model 是仅在实时目录中可见、已存在于生效的本地目录中、在当前会话中可用，还是在当前置信度和策略规则下真正符合自动路由资格。

### 命令示例

```bash
/gsd copilot-models sync
/gsd copilot-models sync --register
/gsd copilot-models changes
/gsd copilot-models pricing
/gsd copilot-models pricing github-copilot/mai-code-1.1-flash
/gsd copilot-models promos
/gsd copilot-models doctor
/gsd copilot-models why github-copilot/gpt-5.4
```

### 失败与“最后已知良好状态”行为

实时 Copilot 快照受以下故障安全（fail-closed）规则保护：

- 认证失败、网络失败、JSON 格式错误或 provider 错误都不会覆盖已知良好的快照；
- 可疑的收缩（例如一个已知良好的目录突然坍缩为零个 models）会被拒绝，而不是被盲目接受；
- `doctor` 会报告已接受的快照是缓存的、过期的、可疑的，还是不存在的；
- 密钥永远不会被写入快照、覆盖文件或诊断信息中。

### 当前限制

- 实时目录路径目前仅针对 GitHub Copilot；其他 provider 仍然依赖各自现有的目录/发现路径。
- 自动路由仍然需要可信的 GSD 能力画像（capability profile）；仅靠实时发现是不够的。
- 配额感知优化尚不属于当前功能的一部分。
- 规划文档中讨论的、更长远的“provider 自持”实时目录架构仍是未来方向；当前实现在 GSD 的内置 extension 层内安全地交付。

<a id="openai-compatibility"></a>
## OpenAI 兼容性

对于只部分兼容 OpenAI 的 providers，可通过 `compat` 字段修正行为。

- provider 级别的 `compat` 会作为该 provider 下所有 models 的默认值
- model 级别的 `compat` 会覆盖该 model 的 provider 级别设置

```json
{
  "providers": {
    "local-llm": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "compat": {
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": [...]
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `supportsStore` | Provider 是否支持 `store` 字段 |
| `supportsDeveloperRole` | 是否使用 `developer` 而非 `system` role |
| `supportsReasoningEffort` | 是否支持 `reasoning_effort` 参数 |
| `reasoningEffortMap` | 把 GSD 的 thinking levels 映射到 provider 专属 `reasoning_effort` 值 |
| `supportsUsageInStreaming` | 是否支持 `stream_options: { include_usage: true }`（默认 `true`） |
| `maxTokensField` | 使用 `max_completion_tokens` 还是 `max_tokens` |
| `requiresToolResultName` | tool result message 中是否必须包含 `name` |
| `requiresAssistantAfterToolResult` | tool result 之后、user message 之前是否需要插入 assistant message |
| `requiresThinkingAsText` | 是否把 thinking block 转成纯文本 |
| `thinkingFormat` | 使用 `reasoning_effort`、`zai`、`qwen` 或 `qwen-chat-template` 的 thinking 参数格式 |
| `supportsStrictMode` | 是否在 tool definitions 中包含 `strict` 字段 |
| `openRouterRouting` | 传给 OpenRouter 的路由配置，用于 model/provider 选择 |
| `vercelGatewayRouting` | Vercel AI Gateway 的路由配置，用于 provider 选择（`only`、`order`） |

`qwen` 使用顶层 `enable_thinking`。对于要求 `chat_template_kwargs.enable_thinking` 的本地 Qwen-compatible server，请使用 `qwen-chat-template`。

示例：

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "openrouter/anthropic/claude-3.5-sonnet",
          "name": "OpenRouter Claude 3.5 Sonnet",
          "compat": {
            "openRouterRouting": {
              "order": ["anthropic"],
              "fallbacks": ["openai"]
            }
          }
        }
      ]
    }
  }
}
```

Vercel AI Gateway 示例：

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "AI_GATEWAY_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "moonshotai/kimi-k2.5",
          "name": "Kimi K2.5 (Fireworks via Vercel)",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0.6, "output": 3, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 262144,
          "maxTokens": 262144,
          "compat": {
            "vercelGatewayRouting": {
              "only": ["fireworks", "novita"],
              "order": ["fireworks", "novita"]
            }
          }
        }
      ]
    }
  }
}
```
