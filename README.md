# ruleset

一份 Surge 语法的规则源，自动生成 Surge、Clash (mihomo)、sing-box、v2ray/Xray 四种格式。

- `rules/*.list`：规则源（Surge 语法，不写策略）
- `scripts/`：Surge 模块脚本
- `src/`：生成器（Bun + TypeScript）
- `test/`：校验与匹配测试

每次 push 到 `main`，CI 会生成、测试，全部通过后发布到 [`release`](../../tree/release) 分支。

## 引用地址

前缀：`https://raw.githubusercontent.com/XiaoMouz/ruleset/release`

| 平台 | 路径 | 说明 |
|---|---|---|
| Surge | `/surge/rules/<名称>.list` | 原样保留全部规则 |
| Surge 脚本 | `/surge/scripts/<名称>.js` | |
| Clash (mihomo) | `/clash/<名称>.yaml` | `behavior: classical` |
| | `/clash/<名称>.mrs` | 仅纯域名 / 纯 IP 的规则集；`behavior` 见 `report.json` 的 `clashMrs` |
| sing-box | `/sing-box/<名称>.srs` | 二进制；同名 `.json` 为源文件 |
| v2ray / Xray | `/v2ray/ruleset-site.dat`、`/v2ray/ruleset-ip.dat` | 标签为规则集名称小写，如 `ext:ruleset-site.dat:claude-domains` |

## 各平台支持的规则类型

不支持的类型会在该平台的输出里去掉，明细见 `release` 分支的 `report.json`。

| 类型 | Surge | Clash | sing-box | v2ray |
|---|---|---|---|---|
| DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD | ✅ | ✅ | ✅ | ✅ |
| IP-CIDR / IP-CIDR6 | ✅ | ✅ | ✅ | ✅ |
| IP-ASN | ✅ | ✅ | — | — |
| PROCESS-NAME | ✅ | ✅ | ✅ | — |
| USER-AGENT / URL-REGEX / AND / OR / NOT | ✅ | — | — | — |

## 本地开发

```bash
bun install
bun run build          # 生成到 dist/（需要 mihomo、sing-box）
bun run test           # 跑所有已安装工具的测试
bun run test:surge     # 用本机 surge-cli 检查 Surge 输出
```

测试内容：

- **surge-api**：把每个规则集展开成配置，交给 `services.nssurge.com/v1/config/validate` 校验（该服务遇到 AND/OR/NOT 会报错，这类规则先跳过）
- **surge-local**：同样的配置交给本机 `surge-cli -c`
- **sing-box**：`sing-box rule-set match` 逐条验证样例
- **mihomo** / **xray**：启动客户端，每个规则集一个代理入口，发送样例请求，从日志读取命中结果

样例来自 `test/cases.ts`：手写用例，加上从每个规则集自动抽取的正例和反例。
