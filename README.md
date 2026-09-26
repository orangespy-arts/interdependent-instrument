# Interdependent Instrument

双人动作与声音依赖规则研究原型，依据 `prototype-dev-guide.md` 和论文第 4 章搭建，使用 soundworks v5。两部手机分别播放声部 0 / 1；研究者在电脑上控制熟悉、分工、调制、共识四个阶段。

当前是可运行的初始原型。代码与服务器通信可自动验证；实际手机的传感方向、声音效果、同步精度、延迟和防锁屏仍需试运行。

## 启动

需要 Node.js 24 LTS（项目最低要求 Node 22）与 npm。在项目目录执行：

```sh
npm ci
npm run dev
```

或先构建，再以不自动重启的方式运行（采集数据时推荐）：

```sh
npm run build
npm start
```

- 电脑控制台：<https://localhost:8000/controller>
- 手机参与者端：`https://电脑的局域网IP:8000/`
- 同一局域网内的控制台：`https://电脑的局域网IP:8000/controller`

启动终端会列出本机可用的局域网地址。两部手机和电脑应连接同一 Wi-Fi；手机不能使用 `localhost`。系统防火墙若询问，应允许 Node 在该局域网接收连接。

默认开启 HTTPS。soundworks 使用自签名证书，首次访问可能出现证书警告，需要研究者在自己的设备上检查并处理，再交给参与者。不要将正式体验改成 HTTP；运动权限需要安全上下文。若自签名证书在目标手机上仍不能获得权限，使用该设备信任的证书，在 `config/env-local.yaml` 配置 `httpsInfos.cert` / `key`，并用 `ENV=local npm run dev` 启动。

`logs/`、本地配置、证书与构建产物均不提交。默认控制端没有登录验证，按指南用于研究者管理的独立局域网。

## 一组体验

1. 研究者提前检查两台同型号手机的音量、勿扰、证书与运动权限；手机打开参与者网址。
2. 参与者读附录 4.A 的原文，点击“开始”授权音频和运动传感器，之后始终黑屏。控制台出现两台设备和实时特征。
3. 开启录像；在控制台输入组别编号、选择三条规则的顺序，点击“开始记录”，再发送“起始同步音”。
4. 点击“熟悉阶段”，然后按预先选择的顺序手动切换三个阶段。每次有效阶段切换使用相同的提示音。选择顺序只写日志，不会自动切换。
5. 结束前发送“结束同步音”，保留录像中的这一声，再停止记录，切到“待机 / 静音”。

断线后手机停止声音并保持黑屏，由研究者重新载入页面恢复。后台返回会重新申请 Wake Lock 并等待有效传感数据；若浏览器暂停音频且不能自动恢复，研究者应重载、重新点击开始。第三台参与者设备不能取得声部编号。

## 调参和待决定项

统一修改 `src/shared/params.js`，重新构建并刷新所有设备；记录开始时会把完整参数写入日志。

- `phaseDuration: null`：每阶段分钟数尚待试运行决定，引导保留 `【X】`。设置后，引导总时长为 `phaseDuration × 4`，对应附录的总体验时长；不会自动切换阶段。
- `tiltAxis: 'y'`、倾斜范围 ±60°、强度参考上限 360°/s：需要按实际握持方向校准。`@ircam/devicemotion` 提供的角速度单位是度/秒。
- 共同层暂用同音阶的交错琶音。音色、共同层内容、`duckGain`、分工是否中途交换均待听觉试运行。
- 共识窗口初值 200 ms，保持 2 秒；用实测网络延迟波动再校准。

详见 [真机验收清单](docs/PILOT-CHECKLIST.md) 与 [开发日志](docs/DEVLOG.md)。原指南的 `latest` 已指向 v6，因此脚手架固定为 5.1.3，框架和插件保持 v5；实际安装版本见 `package-lock.json`。

## 验证

```sh
npm test       # 特征、映射、共识、会话日志、音频调度的单元测试
npm run lint
npm run build
```

在没有真实参与者、没有正在记录的情况下，先启动服务器，再在另一个终端运行：

```sh
npm run smoke
```

此检查用真实 soundworks 网络连接模拟控制端和两台参与者，测试编号、共享状态、阶段命令、共识和 JSONL 日志。它会生成一个 `SMOKE_…` 测试组日志，不代表真机传感或音频验收。

## 结构

```text
config/                         HTTPS、路由和客户端角色
src/server.js                   soundworks 服务器与控制命令
src/server/Session.js            会话、记录和统一共识调度
src/server/Consensus.js          峰值配对与保持逻辑
src/shared/params.js             唯一试运行参数文件
src/shared/features.js           传感特征与峰值提取
src/shared/mapping.js            computeVoiceParams 纯映射函数
src/shared/instructions.js       附录 4.A 引导原文
src/clients/player.js            授权、黑屏、传感、状态通信
src/clients/player/AudioEngine.js 本地 Web Audio 引擎
src/clients/controller/          研究者控制台与实时图表
tests/                          行为测试
scripts/smoke.mjs                真实服务器通信检查
logs/                           按组存储 JSONL（自动创建）
```

个人动作先在本机送入音频引擎，然后最多约 30 Hz 上报共享状态；共识只由服务器判定。同一个峰值最多参与一次配对，过期、未来或乱序峰值不会触发共同层；共同层起点和提示音都安排在未来的共享时间上。共同层起点同时驱动个人声部减弱，避免两端因消息到达时差而提前压低声音。

## 日志

`logs/` 下每次记录创建独立文件，文件名由 logger 添加时间与序号前缀，包含组别编号。每行一个 JSON 对象，`t` 为该次服务器进程的共享时钟秒数，不能跨服务器重启直接比较。

主要类型：`session`、`device`、`features`、`peak`、`phase`、`cue`、`joint`、`syncBeep`、`divisionSwap`、`disconnect`、`session-end`。会话首行含完整参数、计划顺序和开始时的状态；结束行含实际访问阶段顺序。

`features` / `peak` 的 `t` 是手机测量时间，`received` 是服务器接收时间。`cue` / `syncBeep` / 共同层开始的 `t` 是计划播放时间，`scheduledAt` 是安排时间。这些时间不是麦克风实测的发声时间；实际输出延迟需单独测量。录像首尾两声同步音用于与日志对应，±1 帧精度需实测后才能确认。

## API 依据

- [soundworks v5 入门](https://soundworks.dev/tutorials/getting-started.html)
- [共享状态](https://soundworks.dev/tutorials/state-manager.html)
- [platform-init](https://soundworks.dev/plugins/platform-init.html)、[sync](https://soundworks.dev/plugins/sync.html)、[checkin](https://soundworks.dev/plugins/checkin.html)、[logger](https://soundworks.dev/plugins/logger.html)

实现同时核对了安装版本的源码。指南中的事件字段示意需要修正为 `default: null`：v5 不允许 `event: true` 的字段使用非空默认值。
