# GitHub 研究与取舍

核验时间：2026-10-20T12:25:11.343913+00:00。精确star来自公开GitHub网页内嵌计数；公共API限流后使用网页核验。源码固定到如下提交，仅作为研究材料读取，未运行下载代码。

以下为重新编写的本地工作流，未安装上游插件、hooks、运行时或遥测。

## obra/superpowers

star：302399；已归档：False；提交：`bb92a77741419a4ab5f06e711a283343f1ada0c3`。

- [skills/systematic-debugging/SKILL.md](https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/systematic-debugging/SKILL.md)

- [skills/verification-before-completion/SKILL.md](https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/verification-before-completion/SKILL.md)

- [LICENSE](https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/LICENSE)

采用：先追溯输入/组件边界的首次偏差、从生产源头修复、完成前新鲜验证。未采用：所有小任务强制完整调试流程、固定三次后要求用户介入、完整bootstrap与默认分派。两个SKILL正文已完整阅读。

## affaan-m/ECC

star：284466；已归档：False；提交：`6f1881aeafa3c48f7b603cc4be4b2e4e70daad59`。

- [skills/eval-harness/SKILL.md](https://github.com/affaan-m/ECC/blob/6f1881aeafa3c48f7b603cc4be4b2e4e70daad59/skills/eval-harness/SKILL.md)

- [skills/verification-loop/SKILL.md](https://github.com/affaan-m/ECC/blob/6f1881aeafa3c48f7b603cc4be4b2e4e70daad59/skills/verification-loop/SKILL.md)

- [LICENSE](https://github.com/affaan-m/ECC/blob/6f1881aeafa3c48f7b603cc4be4b2e4e70daad59/LICENSE)

采用：先定结果条件、区分代码/规则/模型/人工判分、固定回归与明确原始案例数量。eval-harness和verification-loop正文已阅读。未采用：默认80%覆盖率、固定15分钟复查、无关安全grep、依赖其整套运行框架。其源码明示候选隔离执行尚不可用，不能将其工具回执当模型已验证。

## anthropics/skills

star：182386；已归档：False；提交：`dbd4588f9e1033efb41dad4bef2f7947c8993d44`。

- [skills/skill-creator/SKILL.md](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator/SKILL.md)

采用：实际输入产出、旧/新版本对照、保留案例、结果与时间成本分开。阅读skill-creator创建和测试部分；未运行其脚本。未采用：自动分派、强制问用户确认案例、开启评审网页或复制另一套skill-creator覆盖系统技能。

## gsd-build/get-shit-done

star：64271；已归档：True；提交：`bdcaab2c752d9a33a1a1ca9acf3a3c81fb991815`。

- [agents/gsd-verifier.md](https://github.com/gsd-build/get-shit-done/blob/bdcaab2c752d9a33a1a1ca9acf3a3c81fb991815/agents/gsd-verifier.md)

- [LICENSE](https://github.com/gsd-build/get-shit-done/blob/bdcaab2c752d9a33a1a1ca9acf3a3c81fb991815/LICENSE)

已归档，不安装。仅参考verifier开头的目标反推与存在/实质/接线分层；只读了相关段落，不声称审查完整框架。

## OthmanAdi/planning-with-files

star：27548；已归档：False；提交：`d363544caea69df35ba624b238662ab861d1d92a`。

- [.agents/skills/planning-with-files/SKILL.md](https://github.com/OthmanAdi/planning-with-files/blob/d363544caea69df35ba624b238662ab861d1d92a/.agents/skills/planning-with-files/SKILL.md)

- [LICENSE](https://github.com/OthmanAdi/planning-with-files/blob/d363544caea69df35ba624b238662ab861d1d92a/LICENSE)

采用：同任务单一当前目录和明确来源，不按“最新mtime”误选。阅读SKILL开头任务恢复与文件归属部分。未采用：三份强制文件、每两次操作写日志、hooks和后台循环、阻止结束的门禁、会话库回放。