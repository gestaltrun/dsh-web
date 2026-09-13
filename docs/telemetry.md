# 安装遥测（telemetry）

Gestaltrun 家族插件的创意工坊安装统计处于关闭状态。`shared/client/telemetry.ts` 保留供现有插件调用的空操作 API，不生成访客标识、不读写每日去重状态，也不向 `dsh-market.com` 发送心跳。既有浏览器存储内容保持原样。

包内副本由 `scripts/sync-shared.mjs` 同步。`release:pack` 拒绝包含创意工坊统计端点的可执行归档；普通浏览器与自动化浏览器均适用。该设置只控制社区插件的工坊安装统计，不控制 DSH 自身的遥测。

`market/worker` 中的站点统计代码属于上游站点源码，不随 Desktop 插件组合安装或部署。
