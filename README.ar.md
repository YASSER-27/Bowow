<p align="center">
  <img src="assets/icon.png" width="200" alt="Logo">
  <h1 align="center">Bowow (BETA) </h1>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <img src="assets_img/16469020.png" width="500" alt="Logo">
</p>

<p align="center">
<a href="README.md">English</a> |
<a href="README.ar.md">العربية</a> 
</p>

وكيل بناء ذكي يعمل بالذكاء الاصطناعي يُنشئ ويُعدّل ويدير ملفات المشاريع من خلال محادثة باللغة الطبيعية. مبني بـ React و TypeScript و Electron و Zustand.

## المميزات

- **توليد الكود بالذكاء الاصطناعي** — صف ما تريد بناؤه، والوكيل يُنشئ الملفات، ويُعدّل الكود، ويشغل الأوامر، ويكرّر بناءً على ملاحظاتك.
- **دعم نماذج متعددة** — يعمل مع Gemini و OpenAI و OpenRouter و Ollama و llama.cpp.
- **وضع الشاشة المقسمة** — بدّل لعرض 4 ألواح (F10) لإدارة عدة جلسات بناء في وقت واحد.
- **تحرير الملفات المباشر** — الوكيل يقرأ، يكتب، ويُظهر الفروقات في الملفات مباشرة على القرص.
- **نظام نقاط الحفظ** — تراجع عن تغييرات الملفات باستخدام الـ checkpoint.
- **إدارة السياق** — ضغط وتقليم آلي للمحادثة للبقاء ضمن حدود سياق النموذج.
- **إعادة المحاولة التلقائية** — يكشف الأخطاء المؤقتة ويعيد المحاولة مع تأخير تصاعدي.
- **واجهة متجاوبة** — حجم خط يتكيف مع حجم النافذة.
- **حفظ الجلسات** — كل البناءات والمحادثات والملفات تبقى بعد إغلاق البرنامج عبر التخزين في ملف.

## التقنيات

| الطبقة | التقنية |
|---|---|
| الواجهة | React 18 + TypeScript |
| الحالة | Zustand 5 |
| البناء | Vite + electron-builder |
| سطح المكتب | Electron 33 |
| APIs الذكاء | Gemini, OpenAI, OpenRouter, Ollama, llama.cpp |


<p align="center">
  <img src="assets_img/gif_bowow.gif" width="600" alt="Logo">
</p>

## بدء الاستخدام

### المتطلبات

- Node.js 20+
- npm

### التثبيت

```bash
npm install
```

### التطوير

```bash
npm run dev
```

### بناء النسخة النهائية

```bash
# ويندوز
npm run build:win

# ماك
npm run build:mac

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
  <img src="assets_img/bowow.png" width="100" alt="Logo">
</p>
