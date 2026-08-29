# 吴家阅读打卡网站（Reading Check-in）

学生阅读打卡系统：每天中文朗读录音 5 分钟 + 英文朗读录音 5 分钟，家长后台可查看记录并在线播放音频。

- 线上地址：https://dk.huaguo.site （备用：https://daka.huaguo.site ，测试：https://test.huaguo.site ）

---

## 一、代码位置

| 文件 | 说明 |
|------|------|
| `server.js` | 后端主程序（Node 24 内置 `node:sqlite` + `http`，**零 npm 依赖**，监听 127.0.0.1:3110） |
| `public/index.html` | 登录页：学生点头像免密直进；家长点「我是家长」密码登录 |
| `public/checkin.html` | 学生打卡页：中文/英文各 5 分钟录音、试听、保存、重录覆盖、本月日历 |
| `public/admin.html` | 家长后台：记录列表（按学生/日期筛选）、在线播放、统计、重置学生密码 |
| `public/app.js` | 前端公共工具：`api()`（fetch 封装，带 cookie）、`guard()`（登录校验）、`toast()` 等 |
| `public/app.css` | 全站样式（移动优先，暖色系） |
| `data/app.db` | SQLite 数据库（users / checkins 两张表，运行时自动创建） |
| `uploads/` | 录音文件存储：`uploads/{userId}/{date}/cn.webm|en.webm`（90 天自动清理） |

部署相关（不在本项目目录）：
- systemd 服务：`/etc/systemd/system/checkin.service`（User=wutao，`sudo systemctl restart checkin`）
- Caddy 配置：`/etc/caddy/Caddyfile` 中 `dk.huaguo.site` / `daka.huaguo.site` / `test.huaguo.site` 三个站点反代到 `127.0.0.1:3110`
- 运行用户：wutao（工作目录 `/home/wutao/checkin-site`）

---

## 二、功能描述

### 前台（学生端）
1. **免密直进**：首页两个大按钮（🐾 无花果 / 🍐 妹妹），点击即创建学生会话进入打卡页，无需密码；家长入口另有密码。
2. **阅读打卡（核心）**：打卡页有「🇨🇳 中文朗读」「🇬🇧 English」两张录音卡片：
   - 点「开始录音」→ 浏览器 MediaRecorder 录音，计时器实时显示，**5:00 自动停止**；
   - 录完可试听、重录；点「保存」上传音频；
   - 已保存后显示时长和保存时间，可随时重录覆盖（取最新一次）。
3. **今日状态**：顶部显示今天中文/英文是否已打卡。
4. **本月日历**：绿色=中英都完成，黄色=只完成一半，灰=未打卡，今天有橙色描边。
5. 每天 10 分钟（中文 5 + 英文 5），可多次重录，当天多次上传取最新。

> ⚠️ **未实现（需求确认过「两种都要」）**：目前只有浏览器直接录制，**「上传已有音频文件」功能还没做**，需要补一个文件上传入口（后端 `/api/audio` 已支持任意音频格式 raw body 上传，前端加 `<input type="file">` 即可）。

### 后台（家长端）
1. **密码登录**：admin（初始密码 admin2026，建议登录后修改）。
2. **筛选**：全部/单个学生 + 日期范围（快捷：本周/本月）。
3. **记录列表**：日期、学生、中文时长/时间、英文时长/时间、状态（完整/一半/未打卡）、播放按钮。
4. **在线播放**：底部播放器，点击「▶ 中文 / ▶ 英文」播放对应录音。
5. **统计**：范围内打卡天数、中英完整天数、累计录音分钟数。
6. **重置学生密码**（学生当前免密，此功能备用；admin 自己改密码的前端入口未做，API `/api/password` 已支持）。

### 系统特性
- 音频保留 **90 天**自动删除（服务启动 + 每 6 小时扫描一次，删除后记录字段清空，后台显示「音频已过期」）。
- 会话有效期 7 天（HttpOnly cookie）。
- 权限：学生只能看自己的记录；admin 可看全部。

---

## 三、设计思路

### 1. 零依赖、极简部署
Node 24 内置 `node:sqlite`（DatabaseSync）和 `http` 模块，服务端起一个 http server 同时提供：
- 静态文件（public/ 下页面，每请求读盘、`Cache-Control: no-store`，改前端文件**无需重启**）；
- JSON API（`/api/*`）。

### 2. 数据模型
```
users:    id, username, password(scrypt+盐), salt, name, role(student|admin), created_at
checkins: id, user_id, date(YYYY-MM-DD), cn_path, cn_duration, cn_uploaded_at,
          en_path, en_duration, en_uploaded_at, updated_at
          UNIQUE(user_id, date)
```
- 打卡以「某学生某天」为粒度（UNIQUE 约束），中文、英文各存一条音频路径，**独立覆盖、取最新**（重录只覆盖对应语种）。
- 数据库文件缺失时自动建表 + 播种初始账号（wuyou / wushuang / admin）。

### 3. 会话与认证
- 登录成功发 `sid` HttpOnly cookie，token 存在**进程内存 Map**（重启即失效，学生重新点头像即可）。
- **多 cookie 兼容**（2026-08-29 修复）：`currentUser()` 遍历请求中所有 `sid` cookie 找第一个有效会话；登录/退出时同时清理旧路径（`/api`、`/checkin`）残留 cookie。修复前只读第一个 sid，旧 cookie 残留会导致「点妹妹回主页」。
- 学生免密登录走 `/api/student-login`（只接受 role=student）；家长走 `/api/login`（校验密码）。
- ⚠️ 免密是家庭内网场景的取舍：任何知道网址的人都能以学生身份打卡（只能看到该学生自己的记录），若对外公开需加防护。

### 4. 音频方案
- 前端 MediaRecorder 录 webm（Safari 用 mp4/m4a），保存时 `fetch` 把 Blob 作为 **raw body** 直接 POST（`POST /api/audio?lang=cn|en&duration=秒`），Content-Type 决定存储扩展名；不用 multipart，最简。
- 音频用相对路径存 DB（相对项目根），播放走 `GET /api/audio/:userId/:date/:lang`（校验登录 + 权限）+ Range 支持。

### 5. 前端录音状态机
每张录音卡片：`idle → recording（计时/自动停）→ recorded（试听/重录/保存）→ saved（可重录覆盖）`，用 `hidden` class 切换按钮组。

### 6. 已知问题 / 待办
- [ ] 「上传已有音频文件」未实现（前端补 file input）
- [ ] admin 修改自身密码的前端入口未做（API 已有）
- [ ] 老 pad 微信内置浏览器打不开：全站证书是 ECDSA，老设备兼容性差；方案 A：全站 Caddy `key_type rsa2048` 转 RSA（影响所有站点，简单粗暴）；方案 B：引导用系统浏览器 + 添加到主屏幕（当前推荐）
- [ ] 学生免密的安全取舍（公开部署前需加口令或登录）

---

## 四、常用操作

```bash
# 启动/重启/查看服务
sudo systemctl restart checkin
sudo systemctl status checkin

# 改代码
# 后端 server.js 改动 → 重启服务生效
# 前端 public/*.html|js|css 改动 → 直接刷新浏览器即可（实时读盘）

# 数据库位置
/home/wutao/checkin-site/data/app.db

# 音频位置
/home/wutao/checkin-site/uploads/{userId}/{date}/

# 测试 API（本地）
curl -s -X POST http://127.0.0.1:3110/api/student-login -H 'Content-Type: application/json' -d '{"username":"wuyou"}'
```

初始账号：wuyou/wuyou2026、wushuang/wushuang2026、admin/admin2026（学生免密后密码备用）。