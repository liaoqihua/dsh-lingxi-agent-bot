# Third-party notices

灵犀（dsh-lingxi-agent-bot）是独立实现，但它的机制参考了下面这些同样使用 MIT 许可的 DSH 插件。
代码按本仓库的结构重写；右下角心情挂饰的素材与交互直接来自 dsh-feiyu-mood，按 MIT 许可复制并适配。

| 项目 | 作者 | 参考的部分 | 许可 |
| --- | --- | --- | --- |
| dsh-fish-memory | Yuuyuko-uu | 会淡忘的长期记忆、证据召回、事实键、按轮次提炼 | MIT |
| dsh-feiyu-mood | Yuuyuko-uu | 机器人心情状态、每轮判断、按会话去重注入、日上限；右下角挂饰的素材（assets/widget/*.png）与交互 | MIT |
| dsh-speak-up | Yuuyuko-uu | 主动搭话的骰子、安静时段、冷却、followup 机制 | MIT |
| dsh-qq-bridge | Yuuyuko-uu | 图片处理与消息分段 | MIT |
| dsh-qq-voice | Yuuyuko-uu | 借宿主 TTS 路由、OneBot record 段发语音 | MIT |
| dsh-agent-md | wwsmiler1-bit | systemPrompt.context 注入、机器人人格文件 | MIT |
| dsh-im | xmanrui | 多通道接入、飞书设备注册、微信 iLink 扫码登录与文本发送、会话↔聊天映射、出站回合 | MIT |
| dsh-qqbot | zaofan-make | QQ 通道的会话派生、出站事件、回合结束语义 | MIT |

分词实现没有引入 jieba 词典，使用本地二元/三元切分；因此不包含它们的词典数据。
