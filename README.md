# ZCode GLM Usage Monitor

> 智谱（GLM）用量监控浮窗：定时抓取用量并绘制趋势，悬浮于桌面

## 运行方式

```
node monitor.mjs   # 或双击 启动监控.cmd
```

## 说明

- `zhipu-endpoints.json`（含账号相关端点）与运行历史 `history.jsonl` 未入库；首次运行请按 `zhipu-endpoints.example.json` 填自己的配置。

## 关于本仓库

- 本仓库为个人项目备份，只包含**程序本体**：不含运行时数据、日志、缓存、构建产物与任何密钥。
- 配置中的密钥一律留空，请自行填入（或改用环境变量）。
- 路径中的 `C:\Users\<you>` 表示你自己的用户目录。
