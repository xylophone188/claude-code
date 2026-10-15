# ECOSYSTEM_MULTINODE_NACOS — PC 多节点治理与 Nacos 拓扑适配

**记录日期**：2026-10-16  
**状态**：已完成本机 Nacos REST、服务注册、健康探测、路由快照与配置中心回读验证。  
**权威归档**：本文必须通过 `~/bin/ccbctl summary upsert ECOSYSTEM_MULTINODE_NACOS.md` 写入 PostgreSQL、Redis 与 OpenViking；仓库 Markdown 仅作为可审阅源文件。

---

## 1. 已验证的当前服务与调用拓扑

### 1.1 Nacos

| 项目 | 实际值 | 验证结果 |
| --- | --- | --- |
| Docker 容器 | `nacos-standalone` | `Up` |
| 镜像 | `nacos/nacos-server:v2.3.2` | 已运行 |
| 部署模式 | `MODE=standalone` | 已确认 |
| 鉴权 | `NACOS_AUTH_ENABLE=false` | 当前无认证 |
| 暴露端口 | `8848` REST、`9848` gRPC、`9849` gRPC/集群通讯 | 均绑定 `0.0.0.0` |
| 就绪探测 | `GET /nacos/v1/console/health/readiness` | 返回 `OK` |
| 服务发现 | `GET /nacos/v1/ns/instance/list?serviceName=...` | 返回合法实例列表 JSON |
| 配置中心 | `POST/GET /nacos/v1/cs/configs` | 发布及回读成功 |

### 1.2 PC 网关与 OmniRoute 服务面

```text
移动 Termux / 外部调用者
  │
  ├─ LAN:       192.168.1.67:20128
  ├─ Tailscale: 100.121.247.3:20128
  └─ VPS/CF:    公网边缘入口
                  │
                  ▼
OpenResty / APISIX standby (20128)
  ├─ /v1/models：60 秒目录缓存 + gzip，保护移动端与上游
  └─ 其他请求 ────────────────────────────────────────────┐
                                                          ▼
OmniRoute frontend edge (20127)
  ├─ /v1/*、OAuth、Agent APIs  -> Source HA: 20147 / 20148
  ├─ 控制面 /api/*              -> Control HA: 20145 / 20146
  ├─ Dashboard                  -> UI: 20141
  └─ 9Router 历史降级路径       -> 20130 / 20132

AgentBox Gateway (18800) ── 模型账号池 / provider 调度
OpenViking (1933)        ── 向量检索与 MCP
PostgreSQL + Redis       ── 权威状态、租约、热缓存
Nacos (8848)             ── 瞬态实例成员关系与动态路由意图
```

实际配置来源：

- `/var/lib/openresty-apisix-standby/conf/nginx.conf`：20128 当前入口，常规请求转发至 `127.0.0.1:20127`。
- `/home/melody/.config/omniroute/frontend-edge/nginx.conf`：20127 按 API 路径将流量分给 20147/20148、20145/20146 和 20141。
- `/home/melody/.config/omniroute-apisix-standby.nginx.conf`：保留了旧版 20131/20132/20130/20127 分层故障转移方案；当前在线正式数据面以 20127 + 20147/20148 为准。
- `ccb-phone-broker.service`：生成 `~/.local/state/ccb-phone/endpoints.json`，移动端通道优先级为 LAN > Tailscale > VPS。
- `autossh`：PC 至 VPS `49.51.228.166` 已维护反向隧道，包括 `-R 12028:127.0.0.1:20128`、`-R 1933:127.0.0.1:1933`。

### 1.3 已观测运行状态

- `omniroute-source-api-b`（20148）`/health` 返回 HTTP 200。
- `agentbox-gateway`（18800）`/health` 返回 HTTP 200。
- `omniroute-source-api-a`（20147）存在偶发阻塞；不能以一次超时就永久摘除，应由阈值化的被动熔断配合主动探测治理。
- `omniroute-hermes-score-front-20152.service` 当前前端指向 20148，并记录过 20148/20136 暂时拒绝连接。Hermes 仍应作为模型级评分/选择层，不替代 Nacos 的节点成员关系。
- 现时无线 ADB 手机节点离线，Phone Broker 因此跳过 LAN，并选择 Tailscale 通道。移动节点未被注册为可路由计算节点。

---

## 2. 异构节点治理策略

| 节点角色 | 典型能力 / 约束 | 初始权重 | 调度定位 | 下线策略 |
| --- | --- | ---:| --- | --- |
| `desktop` | PC：32 CPU、64 GiB RAM、RTX 4090 Laptop 16 GiB、稳定局域网 | 100 | 控制面、推理、数据面主节点 | 连续主动健康失败 3 次后摘除；恢复后再注册 |
| `vps` | 固定公网、反向隧道、资源有限、带宽有成本 | 30 | 公网入口、隧道中继、灾备控制通道 | TCP/HTTP 连续失败后摘除；不得默认承接高显存推理 |
| `mobile` | Termux/Android 会休眠、Wi-Fi/蜂窝切换导致 TCP 断连 | 10（LAN 可提高至 25） | 异步任务、传感器、通知、轻任务 | 心跳中断即退出同步调用池；恢复后重新注册 |

### 2.1 健康模型：主动心跳 + 被动熔断

1. **Nacos 临时实例（ephemeral）**：适用于会休眠或会切网的移动端。默认心跳间隔 5 秒、健康超时 15 秒、删除超时 30 秒；适配器以 5 秒周期续约。
2. **主动探测**：适配器调用声明的 HTTP `health_url`；受鉴权保护而返回 4xx 的 HTTP 端点仍认定为“网络与服务栈在线”，连接超时、拒绝或重置则认定失败。
3. **被动熔断**：OpenResty 已配置 `max_fails` 与 `fail_timeout`；业务请求 5xx、连接超时、429 应影响短期熔断分数，不能与节点永久成员状态混为一谈。
4. **恢复机制**：节点恢复后由健康探测重新注册，而非依赖静态 upstream 配置人工加回。

### 2.2 路由原则

- 请求必须按 `capabilities` 和 `role` 过滤，而不是只按连接可达性。例如 `vps-edge-relay` 能力是 `ingress-relay`，不能被模型推理路由误选为 LLM 执行节点。
- 主数据面保持现有 OmniRoute Source A/B (`20147/20148`) 高可用机制。Nacos 路由快照是外部/跨节点发现层，不应覆写 Omniroute 内部 API 所有权边界。
- 手机节点优先通过 `ccb-phone-broker` 获取 LAN > Tailscale > VPS 上游；移动端不应作为同步主上游。
- 配置变更先写 Nacos Config，再由适配器落地为候选 upstream 片段；必须经 `openresty -t` 验证后才由受控运维流程 reload，禁止适配器直接 reload 网关。

### 2.3 与 PostgreSQL、Redis、OpenViking 的职责边界

| 组件 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| PostgreSQL | 架构事实、会话、事件、任务租约的耐久权威记录 | 高频心跳、瞬态节点发现 |
| Redis | 热缓存、短期 budget、分布式锁/租约 | 耐久架构归档、跨重启成员目录 |
| OpenViking | 语义检索、知识索引、MCP | 反向代理动态 upstream |
| Nacos | 临时服务注册、实例健康、路由意图与动态配置 | 业务状态、租约栅栏、永久事实来源 |

---

## 3. 已落地的 Nacos 拓扑适配器

### 3.1 文件

| 文件 | 作用 |
| --- | --- |
| `scripts/infra/nacos_topology_adapter.py` | 无第三方运行时依赖的 Nacos 注册、心跳、探测、动态路由快照适配器 |
| `scripts/infra/nodes-topology.json` | Desktop / VPS / Termux 三类节点的可审阅示例描述 |
| `scripts/infra/test_nacos_topology_adapter.py` | 参数校验与动态路由渲染单元测试 |

适配器不会直接修改、reload 或重启 APISIX/OpenResty；它只将健康的 Nacos 实例落地为：

```text
~/.local/state/ccb-nacos/dynamic-routes.json
~/.local/state/ccb-nacos/nacos-upstreams.conf
```

后者是包含 `weight`、`max_fails=3`、`fail_timeout=15s` 的候选 Nginx upstream 片段。接入现网前需先审查能力标签、验证语法并由已有发布链负责 reload。

### 3.2 节点描述规范

```json
{
  "id": "pc-omniroute-source-b",
  "role": "desktop",
  "host": "127.0.0.1",
  "port": 20148,
  "weight": 100,
  "latency_type": "ultra-low",
  "health_url": "http://127.0.0.1:20148/health",
  "capabilities": ["llm-inference", "source-api", "control-plane"],
  "metadata": {"region": "local"}
}
```

必填字段：`id`、`role`（仅 `mobile|desktop|vps`）、`host`、`port`。同一个 `host:port` 不能重复。元数据仅接受标量值并在注册时转为 Nacos metadata 字符串。

### 3.3 Nacos 交互 API 规范

| 目的 | 方法与端点 | 关键参数 |
| --- | --- | --- |
| Nacos readiness | `GET /nacos/v1/console/health/readiness` | 返回 `OK` |
| 注册临时实例 | `POST /nacos/v1/ns/instance` | `serviceName`、`groupName`、`ip`、`port`、`weight`、`ephemeral=true`、`metadata` |
| 心跳续约 | `PUT /nacos/v1/ns/instance/beat` | `serviceName`、`groupName`、`beat` JSON |
| 查询健康实例 | `GET /nacos/v1/ns/instance/list` | `serviceName`、`groupName`、`healthyOnly=true` |
| 主动注销 | `DELETE /nacos/v1/ns/instance` | 与注册相同的 IP/port，且必须显式 `ephemeral=true` |
| 写入动态路由配置 | `POST /nacos/v1/cs/configs` | `dataId`、`group`、`content`、`type=json` |
| 读取动态路由配置 | `GET /nacos/v1/cs/configs` | `dataId`、`group` |

已实际验证的 metadata：`role`、`weight`、`latency_type`、`endpoint`、`capabilities`、`node_id`、`region`、`device`、`vram`。

---

## 4. 运维命令

在仓库根目录执行：

```bash
# 查看 Nacos 是否就绪
curl -s http://127.0.0.1:8848/nacos/v1/console/health/readiness

# 仅探测 PC/VPS/Termux 声明节点，不修改 Nacos
python3 scripts/infra/nacos_topology_adapter.py \
  --nodes-file scripts/infra/nodes-topology.json --probe

# 一次性注册健康节点、摘除失效节点并渲染路由快照
python3 scripts/infra/nacos_topology_adapter.py \
  --nodes-file scripts/infra/nodes-topology.json --register-once

# 常驻：5 秒 Nacos 心跳 + 健康探测 + 路由快照同步
python3 scripts/infra/nacos_topology_adapter.py \
  --nodes-file scripts/infra/nodes-topology.json --daemon

# 从 Nacos 中重新生成本地路由快照，不做注册动作
python3 scripts/infra/nacos_topology_adapter.py --sync-routes

# 发布当前健康实例的动态路由 JSON 至 Nacos 配置中心，并回读
python3 scripts/infra/nacos_topology_adapter.py \
  --publish-config omniroute-dynamic-routes.json
python3 scripts/infra/nacos_topology_adapter.py \
  --read-config omniroute-dynamic-routes.json

# 单元测试
python3 scripts/infra/test_nacos_topology_adapter.py

# 查看当前 Nacos 成员
curl -s "http://127.0.0.1:8848/nacos/v1/ns/instance/list?serviceName=agent-ecosystem-nodes"
```

建议将 `--daemon` 以受控 systemd user service 托管，并使用 `Restart=always`。在确认节点描述中的移动端管理地址和 VPS 端口均准确前，保持示例配置以手工执行模式运行。

---

## 5. 实际验收证据

| 验收项 | 结果 |
| --- | --- |
| Nacos readiness | `OK` |
| 服务注册 API | 返回 `ok`，Nacos 返回 `healthy=true` 临时实例 |
| 实例 metadata | 已确认 `role=desktop`、`latency_type=ultra-low`、`weight`、能力标签等回读正确 |
| 配置中心 | `POST /nacos/v1/cs/configs` 返回 `true`，随后 `GET` 成功回读 JSON |
| 多节点探测 | PC Source B、AgentBox、VPS edge 健康；当前 S23U Termux 离线并被跳过 |
| Nacos 路由同步 | 为健康节点生成 JSON 和 Nginx upstream 快照 |
| 常驻心跳 | Daemon 运行期间实例保持可见；SIGINT 后实例列表回读为 `[]`，清理注销成功 |
| 单元测试 | `python3 scripts/infra/test_nacos_topology_adapter.py`：4 tests，`OK` |

---

## 6. 安全与上线前要求

1. 当前 Nacos 配置为 `NACOS_AUTH_ENABLE=false` 且 `8848/9848/9849` 监听 `0.0.0.0`。在任何可被非受信网络访问的环境中，攻击者可读写配置或伪造注册。上线前必须至少启用 Nacos 鉴权并通过防火墙/容器端口绑定限制为 loopback、Tailscale 或受信私网。
2. 动态 upstream 不得仅凭“端口可通”进入 LLM 请求路径。必须使用 `role` + `capabilities` 明确筛选，以免 SSH 端口、VPS 中继或移动 ADB 地址成为错误业务后端。
3. 适配器输出是候选配置，禁止绕过 `openresty -t` 或直接触发网关 reload。配置评审、语法验证和滚动发布仍由现有运维链掌管。
4. 移动节点必须保持 ephemeral。不要将 Android/Termux 标记为永久实例，也不要承诺其可承担同步关键路径。
5. PostgreSQL 的任务租约、Redis 的短期锁和 OpenViking 语义记忆保持原有边界；Nacos 不取代这些权威状态系统。
