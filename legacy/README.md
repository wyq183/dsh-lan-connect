# legacy/ — 旧版（web profile）安装脚本

这三个脚本是 **v0.1.0 时代**给 profiles/web 用的：建 junction + 改 web profile 的 patch。

**v0.2.0 起不再使用**，桌面端改为：
- 插件本体放进 `profiles/desktop/node_modules/dsh-lan-connect/`
- 挂载点写在 `profiles/desktop/cordis.patch.yml` 末尾的 insert 条目

留着只为回溯当时的做法，别无用途。
