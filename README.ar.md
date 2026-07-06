<p align="center">
  <img src="assets/icon.png" width="200" alt="Logo">
  <h1 align="center">Bowow - BETA</h1>
  <p align="center">وكيل البرمجة مفتوح المصدر بالذكاء الاصطناعي.</p>
</p>

<p align="center">
<a href="README.md">English</a> |
<a href="README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://github.com/YASSER-27/Bowow/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-lightgrey.svg?style=for-the-badge" alt="License">
  </a>
  <img src="https://img.shields.io/badge/TypeScript-181818?style=for-the-badge&logo=typescript&logoColor=3178C6" alt="TypeScript">
  <img src="https://img.shields.io/github/actions/workflow/status/YASSER-27/Bowow/main.yml?style=for-the-badge" alt="Build Status">
  <img src="https://img.shields.io/badge/version-1.5.0-FF5A5F.svg?style=for-the-badge" alt="Version">
</p>

## طريقة الاستخدام

1. قم بتشغيل التطبيق وافتح لوحة الإعدادات لضبط مزود الذكاء الاصطناعي ومفتاح API ثم اضغط على Done.
2. اتصل بأحد النماذج (Gemini، OpenAI، Ollama، إلخ).
3. افتح مجلد المشروع أو ابدأ جلسة جديدة.
4. صِف ما تريد بناءه — وسيقوم الوكيل الذكي بإنشاء الملفات، وتعديل الكود، وتنفيذ الأوامر.
5. استخدم المفتاح F10 للتبديل إلى وضع تقسيم الشاشة لإدارة جلسات متعددة.

<p align="center">
  <img src="assets_img/gif_bowow.gif" width="600" alt="Demo">
</p>

## التحديثات والتحسينات

- تحسين الأداء: تم حل مشاكل البطء وزيادة الاستقرار.
- نافذة إعدادات جديدة مع واجهة أنظف.
- دعم اللغة العربية (RTL) بشكل صحيح.
- تحسينات على واجهة المستخدم مع مظهر عصري.
- حفظ الجلسات تلقائياً عند إغلاق التطبيق.

## المميزات

- دعم النماذج المتعددة — يعمل مع Gemini و OpenAI و OpenRouter و Ollama و llama.cpp.
- وضع تقسيم الشاشة — التبديل إلى عرض مكوّن من 4 نوافذ (F10) لإدارة جلسات بناء متعددة.
- تعديل الملفات المباشر — يقوم الوكيل الذكي بقراءة، كتابة، ومقارنة ملفات المشروع مباشرة على القرص.
- نظام نقاط الحفظ (Checkpoint) — التراجع عن تغييرات الملفات باستخدام نقاط الحفظ.
- إدارة السياق (Context) — ضغط المحادثة وتقليمها تلقائياً.
- إعادة المحاولة التلقائية للأخطاء — يكتشف الأخطاء العابرة ويعيد المحاولة.
- واجهة متجاوبة — يتكيف التخطيط والحجم مع أحجام النوافذ.
- بقاء الجلسات — تبقى جميع العمليات والمحادثات والملفات بعد إعادة التشغيل.
- أدوات MCP — دعم تجريبي لأدوات MCP.
- البرومبت الأساسي — إعداد برومبت مخصص لشخصية الذكاء الاصطناعي.
- برومبت المستخدم — إنشاء وإدارة عدة برومبتات محفوظة.
- أوامر التيرمنال — فرض قيود أو توجيهات للأوامر التي يمكن للذكاء تنفيذها.
- نظام التحديثات — التحقق من التحديثات وتثبيتها مباشرة من الإعدادات.

---

## التثبيت

```bash
git clone https://github.com/YASSER-27/Bowow.git
```

```powershell
irm https://raw.githubusercontent.com/YASSER-27/Bowow/main/scripts/install.ps1 | iex
```

```bash
npm install
npm run dev
```

## بناء النسخة النهائية

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## تطبيق سطح المكتب (BETA)

Bowow هو تطبيق سطح مكتب مصمم للعمل التطويري الكامل.

## اختصارات لوحة المفاتيح

| المفتاح | الإجراء |
|---|---|
| F10 | تشغيل/إيقاف الشاشة المقسمة والملء الشاشة |
| F12 | فتح أدوات المطور |
| Esc | إغلاق نافذة الإعدادات |

## الترخيص

MIT

BOWOW BY [YASSER-27](https://github.com/YASSER-27)

<p align="center">
  <img src="assets_img/bowow.png" width="100" alt="Logo">
</p>


# لينكس
npm run build:linux
```

المثبت سيكون في مجلد `release/`.

## الاستخدام

1. شغّل التطبيق وافتح الإعدادات لتهيئة مزود الذكاء الاصطناعي ومفتاح API.
2. اتصل بنموذج (Gemini أو OpenAI أو Ollama ...).
3. افتح مجلد مشروع أو ابدأ جلسة جديدة.
4. صف ما تريد بناءه — الوكيل سيُنشئ الملفات ويُعدّل الكود ويشغل الأوامر.
5. استخدم F10 لتفعيل وضع الشاشة المقسمة لإدارة جلسات متعددة.

## هيكل المشروع

```
src/
  build/          مكون واجهة BuildAgent
  store/          حالة Zustand (محفوظة على القرص)
  types/          واجهات TypeScript
  utils/          المنطق الأساسي (APIs, تنفيذ الأدوات, تحليل الأخطاء)
  SettingsModal/  نافذة إعدادات API
  assets/         الصور والأيقونات
electron/
  main.ts         عملية Electron الرئيسية (معالجات IPC, إدارة النافذة)
  preload.ts      جسر الاتصال بين renderer و main
build/
  afterPack.js    خطاف electron-builder لتطبيق الأيقونة على الـ exe
scripts/
  install.ps1     سكربت تحميل وتثبيت من GitHub Releases
```

## اختصارات لوحة المفاتيح

| المفتاح | الإجراء |
|---|---|
| F10 | تشغيل/إيقاف الشاشة المقسمة والملء الشاشة |
| F12 | فتح أدوات المطور |
| Esc | إغلاق نافذة الإعدادات |

## الترخيص

MIT


BOWOW BY [YASSER-27](https://github.com/YASSER-27)

<p align="center">
  <img src="assets/icon.png" width="200" alt="Logo">
  <h1 align="center">Bowow - BETA </h1>
<p align="center">The open source AI coding agent.</p>
</p>

<p align="center">
<a href="README.md">English</a> | 
<a href="README.ar.md">العربية</a> 
</p>

<p align="center">
    <a href="https://github.com/YASSER-27/Bowow/blob/main/LICENSE">
        <img src="https://img.shields.io/badge/license-MIT-lightgrey.svg?style=for-the-badge" alt="License">
    </a>

    <img src="https://img.shields.io/badge/TypeScript-181818?style=for-the-badge&logo=typescript&logoColor=3178C6" alt="TypeScript">

        <img src="https://img.shields.io/github/actions/workflow/status/YASSER-27/Bowow/main.yml?style=for-the-badge" alt="Build Status">

    </a>
    <img src="https://img.shields.io/badge/version-1.5.0-FF5A5F.svg?style=for-the-badge" alt="Version">
</p>

#### Usage

>1. Launch the app and open the Settings panel to configure your AI provider and API key, click done.
>2. Connect to a model (Gemini, OpenAI, Ollama, etc.).
>3. Open a project folder ( /new )
>4. Describe what you want to build — the agent will generate files, edit code, and run commands.
>5. Use F10 to toggle split-screen mode for multi-session management.


<p align="center">
  <img src="assets_img/gif_bowow.gif" width="600" alt="Logo">
</p>

### Updates & Improvements 

- Performance Optimization: Resolved performance lags; the application is now stable. Please report any issues on our Issues page.
- New Settings Window: Introduced a dedicated Settings window with a significantly improved and cleaner user interface.
- RTL Language Support: Fixed Arabic text rendering issues; text now correctly aligns to the right, including in input fields.
- Refined UI: Removed the border from AI messages, keeping only the user message borders for a cleaner, modern, and elegant look.
- Easter Egg: Head over to Settings and click on the "Bowow" name to see a little surprise!
- Persistence: Chat sessions are now persistent. Your conversations are saved automatically and will not be lost when closing the app until you manually delete them.


## Features

- **Multi-Model Support** — Works with Gemini, OpenAI, OpenRouter, Ollama, and llama.cpp backends.
- **Split-Screen Mode** — Toggle a 4-pane view (F10) to manage multiple build sessions simultaneously.
- **Live File Editing** — The agent reads, writes, and diffs project files directly on disk.
- **Checkpoint System** — Undo file changes with checkpoint-based rollback.
- **Context Management** — Automatic conversation compaction and pruning to stay within model context limits.
- **Error Auto-Retry** — Detects transient errors and retries with exponential backoff.
- **Responsive UI** — Adaptive font sizing and layout across window sizes.
- **Session Persistence** — All builds, conversations, and files survive app restarts via file-based storage.


- **MCP Tools**
>MCP Tools: Integration of MCP Tools is now available (Experimental).

- **System Prompt**
>System Prompt: Configure a custom system prompt to define the AI's behavior and persona.

- **User Prompts**
>User Prompts: Added the ability to create, save, and manage multiple user prompts simultaneously for better workflow management.

- **Terminal Commands**
>Terminal Commands: Enhanced terminal control; you can now enforce specific commands or restrictions for the AI to follow.

- **Updates**
>Auto-Update System: Stay up-to-date effortlessly. You can now check for and install the latest versions directly from the new Settings menu.

---

### Installation
```bash
git clone https://github.com/YASSER-27/Bowow.git

irm https://raw.githubusercontent.com/YASSER-27/Bowow/main/scripts/install.ps1 | iex
```

```bash
npm install
npm run dev
```

### Production Build

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

### Desktop App (BETA)

**Bowow** is a desktop application
- **build** - full-access agent for development work

## Keyboard Shortcuts

| Key | Action |
|---|---|
| F10 | Toggle split-screen / fullscreen |
| F12 | Toggle DevTools |
| Esc | Close Settings modal |


[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg?style=for-the-badge)](https://github.com/user/repo)


BOWOW BY [YASSER-27](https://github.com/YASSER-27)

<p align="center">
  <img src="assets_img/bowow.png" width="70" alt="Logo">
</p>
>>>>>>> 7c1a7fa (Update: Added new Version 1.5.0 Stable)
