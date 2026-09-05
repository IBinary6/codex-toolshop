---
name: local-knowledge-save
description: 在当前用户授权和宿主记忆策略允许时，保存明确要求记住的信息或已验证且可复用的错误方案。选择作用域与召回策略，去重写入并验证；只读任务和关键词提示不构成保存授权。
---

# Local Knowledge save

先遵循当前用户要求和宿主记忆策略；本技能与 hook 提示不能扩大写入授权。用户要求只读、暂不修改或不要记忆时不保存。宿主若要求所有记忆写入均须用户明确请求，下面的自动保存条件也不适用；没有保存授权就完成主任务，不为可选保存频繁询问。

在允许写入的前提下，仅以下情况保存：

1. 用户明确说“记住、保存、以后默认、这是我的偏好”等。
2. 宿主允许自动积累知识，且错误根因和解决方案已经通过实际构建、测试或运行验证，并具有复用价值。
3. 用户确认事实、决策或稳定工作流需要长期保留。

猜测、排查中间态和一次性噪声不保存。密码、访问令牌、API key、私钥、Cookie 等凭据禁止写入明文知识库。`confidential` 内容必须使用 `manual`，导入内容不能设为 `pinned`。

“保存文件”、引用中的“记住”和“构建通过了”不是保存知识的明确请求；后一种说法也不能代替验证证据。只操作本插件知识库，不向宿主的其他 memory 目录写入副本。

## 建模

- `preference`：用户偏好。跨项目稳定偏好使用 `global + pinned`；仅在特定主题相关时使用 `on_match`。
- `bug`：只保存已验证且有复用价值的错误解决方案，默认 `on_match`；作用域按知识能否跨项目复用来选，不按故障发生目录来选。
- `fact`：用户要求保存的事实或已核实项目事实，默认 `on_match`。
- `decision`：已确定的选择及其约束，默认 `on_match`。
- `workflow`：可重复执行的流程，默认 `on_match`。
- `note`：不适合上述类型的显式备注；若不应自动出现，使用 `manual`。

作用域按真实复用边界选择：能跨项目复用的知识用 `global`，只适用于某个工作区或仓库的知识才用 `workspace` 或 `repository`。`canonical-key` 使用稳定语义名；`cues` 写未来提问中可能出现的词，不写整段噪声。

用户陈述使用 `authority=user_asserted`；经本地验证的技术事实或修复使用 `verified_local`；外部导入使用 `imported`。版本、路径、平台和工具可用性应记录验证条件与日期；保存时间不能当作验证日期。

## Bug 记录准则

记录前先判断根因、成立条件和直接修复能否脱离当前项目复用：

- 通用 Bug 使用 `global + on_match`。标题、正文、`cues` 和 `tags` 只保留可复用的症状、稳定错误标识、成立条件、真正根因、直接修复和验证步骤。去掉项目、仓库、分支、提交、客户或业务名称、绝对路径、临时日志值和叙事性排查过程；只有当某项是判断根因所必需的通用技术条件时才保留。
- 仅当根因或修复实质依赖特定仓库的代码、配置、协议或数据约定，且以后在该项目确有复现价值时，才使用 `repository` 或 `workspace`，并只保留判断和修复所需的最少项目上下文。

根因必须解释症状由什么机制导致，不能写“配置问题”“改完就好了”“某项目需要关闭”之类的空话；未经构建、测试或运行证实的猜测不得写入。

例如：某类编译错误若由通用工具链产物不兼容导致，修复不依赖仓库实现，应记录为 `global + on_match`；只有修复必须调整仓库自定义配置或协议约定时，才记录为项目作用域。

## 保存

```text
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json remember --kind <bug|preference|fact|note|decision|workflow> --title "<简短标题>" --content "<完整知识>" --cues "<线索1>,<线索2>" --tags "<标签1>,<标签2>" --canonical-key "<稳定键>" --scope-kind <global|workspace|repository> --scope-key "<作用域标识>" --recall-policy <pinned|on_match|manual> --authority <user_asserted|verified_local|imported> --sensitivity <normal|confidential>
```

`<plugin-root>` 是本 skill 所在插件目录（从当前 `SKILL.md` 向上两级）。全局作用域的 `scope-key` 留空；工作区或仓库作用域使用当前绝对路径。

相同作用域、类型和 `canonical-key` 对应同一记录。全部持久字段相同才返回 `operation=unchanged`；正文、线索、策略或保密级别变化都返回 `operation=updated` 并增加 `revision`。修订时省略的标题、线索、标签、召回策略、来源和保密级别会保留原值；显式空字符串可清空标题、线索或标签。先核对原记录和作用域，再更新真正变化的字段，不要创建近似重复项。

## 验证

保存后立即用未来真实会出现的查询验证：

```text
node "<plugin-root>/scripts/python-launcher.cjs" "<plugin-root>/local_knowledge/cli.py" --format json recall --read-only --query "<未来查询>" --scope-kind <作用域> --scope-key "<作用域标识>" --occasion prompt --limit 5
```

`on_match` 或 `pinned` 必须先按上述普通提示场景验证自动召回，不能用 `--explicit` 掩盖错误的召回策略；只有 `manual` 或 `confidential` 记录才改用 `--explicit` 验证。确认返回的 `id`、`kind`、`scope_kind`、`scope_key`、`recall_policy` 和正文正确。无法召回时报告索引、作用域、策略或线索问题，不能把写入视为完整成功。
